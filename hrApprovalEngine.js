/**
 * Configurable approval hierarchies for leave / OT / etc.
 * Template steps resolve to Leaders (employees) or desk roles at runtime.
 */
export const STEP_KINDS = [
  "team_leader",
  "department_leader",
  "hr",
  "manager",
  "admin",
];

export function normalizeSteps(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list) {
    const kind = String(row?.kind || row || "")
      .trim()
      .toLowerCase();
    if (STEP_KINDS.includes(kind)) out.push({ kind });
  }
  return out;
}

/**
 * @param {{ requireTeamLeaderFirst?: boolean, stepsJson?: unknown }} flow
 * @param {{ hasTeam: boolean }} opts
 */
export function effectiveSteps(flow, { hasTeam }) {
  const requireTeam = flow?.requireTeamLeaderFirst !== false;
  let steps = normalizeSteps(flow?.stepsJson ?? flow?.steps);
  if (!hasTeam || !requireTeam) {
    steps = steps.filter((s) => s.kind !== "team_leader");
  }
  return steps;
}

/**
 * @param {Array} flows — rows with requestType, departmentId, active, stepsJson
 */
export function pickFlow(flows, { requestType, departmentId }) {
  const type = String(requestType || "").trim();
  const list = (flows || []).filter(
    (f) => f.active !== false && String(f.requestType) === type,
  );
  const deptId = departmentId == null || departmentId === "" ? null : Number(departmentId);
  if (deptId != null && Number.isFinite(deptId)) {
    const override = list.find((f) => Number(f.departmentId) === deptId);
    if (override) return override;
  }
  return list.find((f) => f.departmentId == null || f.departmentId === undefined) || null;
}

export function defaultSteps({ businessType, hrSoloManagerEnabled } = {}) {
  const bt = String(businessType || "").toLowerCase();
  const isCafe =
    bt.includes("cafe") || bt.includes("café") || bt.includes("restaurant");
  if (isCafe) {
    if (hrSoloManagerEnabled) return [{ kind: "hr" }, { kind: "admin" }];
    return [{ kind: "admin" }];
  }
  return [{ kind: "department_leader" }, { kind: "manager" }];
}

/**
 * Resolve who can act on a step.
 * @returns {{ employeeIds: number[], roles: string[] }}
 */
export async function resolveAssignees(prisma, { HotelName, kind, employee }) {
  const hotel = String(HotelName || "").trim();
  const k = String(kind || "").trim();
  if (k === "hr") return { employeeIds: [], roles: ["HR"] };
  if (k === "manager") return { employeeIds: [], roles: ["Manager"] };
  if (k === "admin") return { employeeIds: [], roles: ["Admin"] };

  if (k === "team_leader") {
    const teamId = employee?.teamId != null ? Number(employee.teamId) : null;
    if (!teamId) return { employeeIds: [], roles: [] };
    const rows = await prisma.hr_employee.findMany({
      where: {
        HotelName: hotel,
        teamId,
        orgPosition: "leader",
        status: { not: "terminated" },
      },
      select: { id: true },
    });
    return {
      employeeIds: rows.map((r) => r.id).filter((id) => id !== employee?.id),
      roles: [],
    };
  }

  if (k === "department_leader") {
    const dept = String(employee?.department || "").trim();
    if (!dept) return { employeeIds: [], roles: [] };
    const rows = await prisma.hr_employee.findMany({
      where: {
        HotelName: hotel,
        department: dept,
        orgPosition: "leader",
        status: { not: "terminated" },
      },
      select: { id: true },
    });
    return {
      employeeIds: rows.map((r) => r.id).filter((id) => id !== employee?.id),
      roles: [],
    };
  }

  return { employeeIds: [], roles: [] };
}

export function actorCanDecide(assignees, actor) {
  if (!assignees) return false;
  if (actor?.employeeId != null) {
    return assignees.employeeIds.includes(Number(actor.employeeId));
  }
  const role = String(actor?.role || "").trim();
  return Boolean(role) && assignees.roles.includes(role);
}

/**
 * Pure helper: given steps and current index, find next index after escalate skips.
 * Returns { nextIndex, final: boolean, escalatedKinds: string[] }
 */
export function nextIndexAfterEmptyAssignees(steps, fromIndex, assigneeResults) {
  const escalatedKinds = [];
  let i = fromIndex;
  while (i < steps.length) {
    const a = assigneeResults[i];
    const empty =
      !a ||
      ((a.employeeIds?.length || 0) === 0 && (a.roles?.length || 0) === 0);
    if (!empty) return { nextIndex: i, final: false, escalatedKinds };
    escalatedKinds.push(steps[i].kind);
    i += 1;
  }
  return { nextIndex: steps.length, final: true, escalatedKinds };
}

async function loadFlows(prisma, HotelName, requestType) {
  return prisma.hr_approval_flow.findMany({
    where: { HotelName, requestType, active: true },
  });
}

async function resolveDepartmentId(prisma, HotelName, departmentCode) {
  const code = String(departmentCode || "").trim();
  if (!code) return null;
  const row = await prisma.hr_department.findFirst({
    where: { HotelName, code },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Attach flow + initial step (with escalate) when creating a leave request.
 * Does not write actions — caller persists leave then optional escalations.
 */
export async function prepareLeaveFlowAttachment(
  prisma,
  {
    employee,
    businessType,
    hrSoloManagerEnabled,
  },
) {
  const HotelName = employee.HotelName;
  const departmentId = await resolveDepartmentId(
    prisma,
    HotelName,
    employee.department,
  );
  const flows = await loadFlows(prisma, HotelName, "leave");
  let flow = pickFlow(flows, {
    requestType: "leave",
    departmentId,
  });
  if (!flow) {
    flow = {
      id: null,
      requireTeamLeaderFirst: true,
      stepsJson: defaultSteps({ businessType, hrSoloManagerEnabled }),
    };
  }
  const steps = effectiveSteps(flow, { hasTeam: Boolean(employee.teamId) });
  if (!steps.length) {
    return {
      flowId: flow.id,
      currentStepIndex: 0,
      steps: [{ kind: "manager" }],
      escalatedKinds: [],
    };
  }

  const assigneeResults = [];
  for (let i = 0; i < steps.length; i++) {
    assigneeResults.push(
      await resolveAssignees(prisma, {
        HotelName,
        kind: steps[i].kind,
        employee,
      }),
    );
  }
  const { nextIndex, final, escalatedKinds } = nextIndexAfterEmptyAssignees(
    steps,
    0,
    assigneeResults,
  );

  if (final) {
    return {
      flowId: flow.id,
      currentStepIndex: Math.max(0, steps.length - 1),
      steps,
      escalatedKinds,
      forceManager: true,
    };
  }
  return {
    flowId: flow.id,
    currentStepIndex: nextIndex,
    steps,
    escalatedKinds,
    forceManager: false,
  };
}

export async function recordEscalations(prisma, { HotelName, requestId, steps, escalatedKinds }) {
  for (const kind of escalatedKinds || []) {
    const stepIndex = steps.findIndex((s) => s.kind === kind);
    await prisma.hr_approval_action.create({
      data: {
        HotelName,
        requestType: "leave",
        requestId,
        stepIndex: stepIndex < 0 ? 0 : stepIndex,
        stepKind: kind,
        actorType: "credential",
        actorUserName: "system",
        decision: "escalated",
        note: "No assignees — escalated",
      },
    });
  }
}

/**
 * Apply approve/reject for leave; returns updated leave row.
 */
export async function decideLeaveOnEngine(
  prisma,
  {
    leave,
    approve,
    actor,
    note,
    onFinalApprove,
  },
) {
  if (leave.status !== "pending") {
    throw new Error("Leave request already decided");
  }
  const employee = leave.employee;
  if (!employee) throw new Error("Leave employee missing");

  let flow = leave.flowId
    ? await prisma.hr_approval_flow.findUnique({ where: { id: leave.flowId } })
    : null;
  if (!flow) {
    flow = {
      id: leave.flowId,
      requireTeamLeaderFirst: true,
      stepsJson: defaultSteps({}),
    };
  }
  const steps = effectiveSteps(flow, { hasTeam: Boolean(employee.teamId) });
  let stepIndex = Number(leave.currentStepIndex) || 0;
  if (stepIndex < 0 || stepIndex >= steps.length) stepIndex = 0;
  const step = steps[stepIndex] || { kind: "manager" };

  const assignees = await resolveAssignees(prisma, {
    HotelName: leave.HotelName,
    kind: step.kind,
    employee,
  });
  const role = String(actor?.role || "").trim();
  const stepKind = String(step.kind || "").trim();
  /** Credential roles may act on their matching desk step. */
  const roleMatchesStep =
    (role === "HR" && stepKind === "hr") ||
    (role === "Manager" && stepKind === "manager") ||
    (role === "Admin" &&
      (stepKind === "admin" || stepKind === "manager" || stepKind === "hr"));
  /** Manager/Admin may override any step (still advances the chain — does not skip remaining steps). */
  const isDeskOverride = role === "Manager" || role === "Admin";
  if (
    !actorCanDecide(assignees, actor) &&
    !roleMatchesStep &&
    !isDeskOverride
  ) {
    throw new Error("Not an assignee for this approval step");
  }

  const actorType = actor.employeeId != null ? "employee" : "credential";
  await prisma.hr_approval_action.create({
    data: {
      HotelName: leave.HotelName,
      requestType: "leave",
      requestId: leave.id,
      stepIndex,
      stepKind: step.kind,
      actorType,
      actorEmployeeId: actor.employeeId != null ? Number(actor.employeeId) : null,
      actorUserName: String(actor.name || actor.role || "").trim(),
      decision: approve ? "approved" : "rejected",
      note: String(note || "").trim().slice(0, 500),
    },
  });

  if (!approve) {
    return prisma.hr_leave_request.update({
      where: { id: leave.id },
      data: {
        status: "rejected",
        decidedBy: String(actor.name || actor.role || "").trim(),
        decidedAt: new Date(),
      },
      include: { employee: true },
    });
  }

  // Advance: escalate through empty subsequent steps
  let next = stepIndex + 1;
  while (next < steps.length) {
    const a = await resolveAssignees(prisma, {
      HotelName: leave.HotelName,
      kind: steps[next].kind,
      employee,
    });
    if ((a.employeeIds.length || 0) > 0 || (a.roles.length || 0) > 0) break;
    await prisma.hr_approval_action.create({
      data: {
        HotelName: leave.HotelName,
        requestType: "leave",
        requestId: leave.id,
        stepIndex: next,
        stepKind: steps[next].kind,
        actorType: "credential",
        actorUserName: "system",
        decision: "escalated",
        note: "No assignees — escalated",
      },
    });
    next += 1;
  }

  if (next >= steps.length) {
    const updated = await prisma.hr_leave_request.update({
      where: { id: leave.id },
      data: {
        status: "approved",
        currentStepIndex: steps.length,
        decidedBy: String(actor.name || actor.role || "").trim(),
        decidedAt: new Date(),
      },
      include: { employee: true },
    });
    if (typeof onFinalApprove === "function") {
      await onFinalApprove(updated);
    }
    return updated;
  }

  return prisma.hr_leave_request.update({
    where: { id: leave.id },
    data: { currentStepIndex: next, status: "pending" },
    include: { employee: true },
  });
}
