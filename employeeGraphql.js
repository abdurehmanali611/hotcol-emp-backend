import {
  assertEmployee,
  consumeEmployeeLoginAttempt,
  signEmployeeToken,
} from "./lib/employeeAuth.js";
import {
  clearOtpPreviewFields,
  hashPortalOtp,
  isPortalOtpTaken,
  isValidPortalOtpFormat,
  normalizePortalOtp,
  verifyPortalOtp,
} from "./hrPortalOtp.js";
import {
  decideLeaveOnEngine,
  effectiveSteps,
  prepareLeaveFlowAttachment,
  recordEscalations,
  resolveAssignees,
} from "./hrApprovalEngine.js";
import { notifyEmployeeLeaveDecision } from "./hrNotifications.js";

function publicEmployee(row) {
  if (!row) return null;
  return {
    id: row.id,
    HotelName: row.HotelName,
    fullName: row.fullName,
    phone: row.phone || "",
    email: row.email || "",
    department: row.department || "",
    jobTitle: row.jobTitle || "",
    orgPosition: row.orgPosition || "employee",
    teamId: row.teamId ?? null,
    status: row.status || "",
    mustChangeOtp: Boolean(row.mustChangeOtp),
    profileImageUrl: row.profileImageUrl || "",
    portalFirstLoginAt: row.portalFirstLoginAt ?? null,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function assertYmd(value, label) {
  const s = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return s;
}

function todayYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Block new leave while the employee is currently on approved leave. */
async function assertEmployeeCanRequestLeave(db, employee) {
  if (!employee) throw new Error("Employee not found");
  if (String(employee.status || "") === "terminated") {
    throw new Error("Terminated employees cannot request leave");
  }
  const today = todayYmd();
  if (String(employee.status || "") === "on_leave") {
    throw new Error(
      "You are currently on leave and cannot request another leave",
    );
  }
  const activeLeave = await db.hr_leave_request.findFirst({
    where: {
      employeeId: employee.id,
      status: "approved",
      fromYmd: { lte: today },
      toYmd: { gte: today },
    },
    select: { id: true, fromYmd: true, toYmd: true },
  });
  if (activeLeave) {
    throw new Error(
      `You are on leave (${activeLeave.fromYmd} → ${activeLeave.toYmd}) and cannot request another leave`,
    );
  }
}

async function resolveTinForHotel(prisma, hotelName) {
  const key = String(hotelName || "").trim();
  if (!key) return "";
  const byTin = await prisma.tenant_account.findUnique({
    where: { tinNumber: key },
    select: { tinNumber: true },
  });
  if (byTin?.tinNumber) return String(byTin.tinNumber).trim();
  const byName = await prisma.tenant_account.findFirst({
    where: { hotelDisplayName: key },
    select: { tinNumber: true },
  });
  if (byName?.tinNumber) return String(byName.tinNumber).trim();
  const user = await prisma.user.findFirst({
    where: { HotelName: key },
    select: { tinNumber: true },
  });
  return user?.tinNumber ? String(user.tinNumber).trim() : key;
}

async function loadMe(prisma, employeeId) {
  const row = await prisma.hr_employee.findUnique({ where: { id: employeeId } });
  if (!row) throw new Error("Employee not found");
  return row;
}

export const employeeTypeDefs = `
  type HrEmployeePublic {
    id: Int!
    HotelName: String!
    fullName: String!
    phone: String!
    email: String!
    department: String!
    jobTitle: String!
    orgPosition: String!
    teamId: Int
    status: String!
    mustChangeOtp: Boolean!
    profileImageUrl: String!
    portalFirstLoginAt: DateTime
  }

  type EmployeeSession {
    token: String!
    employee: HrEmployeePublic!
  }

  type HrNotificationEmp {
    id: Int!
    kind: String!
    title: String!
    body: String!
    href: String!
    actionStatus: String!
    readAt: DateTime
    createdAt: DateTime!
  }

  type EmpLeaveRequest {
    id: Int!
    leaveType: String!
    fromYmd: String!
    toYmd: String!
    days: Float!
    reason: String!
    status: String!
    currentStepIndex: Int!
    decidedBy: String!
    decidedAt: DateTime
    createdAt: DateTime!
    employeeName: String!
  }

  type EmpPayslip {
    id: Int!
    payslipNumber: String!
    employeeName: String!
    netPayETB: Float!
    grossSalaryETB: Float!
    paymentStatus: String!
    periodKey: String!
    monthName: String!
    fromYmd: String!
    toYmd: String!
    createdAt: DateTime!
  }

  type EmpLeaveType {
    code: String!
    label: String!
    paid: Boolean!
  }

  type EmpLeaveBalance {
    leaveType: String!
    label: String!
    paid: Boolean!
    balanceDays: Float!
    pendingDays: Float!
    availableDays: Float!
  }

  type EmpAttendance {
    id: Int!
    workDate: String!
    clockInAt: DateTime
    clockOutAt: DateTime
    status: String!
    notes: String!
  }

  type EmpIncident {
    id: Int!
    kind: String!
    title: String!
    detail: String!
    occurredYmd: String!
    salaryDeduct: Boolean!
    percentOfSalary: Float!
    amountETB: Float!
    createdAt: DateTime!
  }

  type EmpShift {
    id: Int!
    workDate: String!
    department: String!
    startTime: String!
    endTime: String!
    notes: String!
  }
`;

export const employeeQueryFields = `
  employeeMe: HrEmployeePublic!
  employeeNotifications(unreadOnly: Boolean): [HrNotificationEmp!]!
  myLeaveRequests: [EmpLeaveRequest!]!
  myLeaveTypes: [EmpLeaveType!]!
  myLeaveBalances: [EmpLeaveBalance!]!
  pendingApprovalsForMe: [EmpLeaveRequest!]!
  myPayslips: [EmpPayslip!]!
  myAttendance(limit: Int): [EmpAttendance!]!
  myIncidents(limit: Int): [EmpIncident!]!
  myShifts(limit: Int): [EmpShift!]!
`;

export const employeeMutationFields = `
  employeeLogin(otp: String!): EmployeeSession!
  changeOwnOtp(currentOtp: String!, newOtp: String!): Boolean!
  markOwnNotificationRead(id: Int!): HrNotificationEmp!
  updateOwnProfile(profileImageUrl: String, phone: String, email: String): HrEmployeePublic!
  createOwnLeaveRequest(
    leaveType: String!
    fromYmd: String!
    toYmd: String!
    days: Float
    reason: String
  ): EmpLeaveRequest!
  decideLeaveAsAssignee(id: Int!, approve: Boolean!, note: String): EmpLeaveRequest!
`;

function mapLeave(row) {
  return {
    id: row.id,
    leaveType: row.leaveType,
    fromYmd: row.fromYmd,
    toYmd: row.toYmd,
    days: row.days,
    reason: row.reason || "",
    status: row.status,
    currentStepIndex: row.currentStepIndex || 0,
    decidedBy: row.decidedBy || "",
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    employeeName: row.employee?.fullName || "",
  };
}

export const employeeResolvers = {
  Query: {
    employeeMe: async (_, __, context) => {
      const employeeId = assertEmployee(context);
      return publicEmployee(await loadMe(context.prisma, employeeId));
    },

    employeeNotifications: async (_, { unreadOnly }, context) => {
      const employeeId = assertEmployee(context);
      return context.prisma.hr_notification.findMany({
        where: {
          employeeId,
          ...(unreadOnly ? { readAt: null } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    },

    myLeaveTypes: async (_, __, context) => {
      const me = await loadMe(context.prisma, assertEmployee(context));
      return context.prisma.hr_leave_type.findMany({
        where: { HotelName: me.HotelName, active: true },
        orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      });
    },

    myLeaveBalances: async (_, __, context) => {
      const me = await loadMe(context.prisma, assertEmployee(context));
      const [types, balances, pending] = await Promise.all([
        context.prisma.hr_leave_type.findMany({
          where: { HotelName: me.HotelName, active: true },
          orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
        }),
        context.prisma.hr_leave_balance.findMany({
          where: { employeeId: me.id },
        }),
        context.prisma.hr_leave_request.findMany({
          where: { employeeId: me.id, status: "pending" },
          select: { leaveType: true, days: true },
        }),
      ]);
      const balanceByType = new Map(
        balances.map((b) => [String(b.leaveType), Number(b.balanceDays) || 0]),
      );
      const pendingByType = new Map();
      for (const row of pending) {
        const key = String(row.leaveType || "");
        pendingByType.set(
          key,
          (pendingByType.get(key) || 0) + (Number(row.days) || 0),
        );
      }
      const codes = new Set([
        ...types.map((t) => String(t.code)),
        ...balanceByType.keys(),
      ]);
      const typeMeta = new Map(
        types.map((t) => [
          String(t.code),
          { label: t.label || t.code, paid: Boolean(t.paid) },
        ]),
      );
      return [...codes]
        .filter(Boolean)
        .sort((a, b) => {
          const la = typeMeta.get(a)?.label || a;
          const lb = typeMeta.get(b)?.label || b;
          return la.localeCompare(lb);
        })
        .map((code) => {
          const meta = typeMeta.get(code) || { label: code, paid: true };
          const balanceDays = round2(balanceByType.get(code) || 0);
          const pendingDays = round2(pendingByType.get(code) || 0);
          return {
            leaveType: code,
            label: meta.label,
            paid: meta.paid,
            balanceDays,
            pendingDays,
            availableDays: round2(Math.max(0, balanceDays - pendingDays)),
          };
        });
    },

    myLeaveRequests: async (_, __, context) => {
      const employeeId = assertEmployee(context);
      const rows = await context.prisma.hr_leave_request.findMany({
        where: { employeeId },
        include: { employee: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return rows.map(mapLeave);
    },

    pendingApprovalsForMe: async (_, __, context) => {
      const me = await loadMe(context.prisma, assertEmployee(context));
      if (me.orgPosition !== "leader") return [];
      const pending = await context.prisma.hr_leave_request.findMany({
        where: { HotelName: me.HotelName, status: "pending" },
        include: { employee: true, flow: true },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      const out = [];
      for (const leave of pending) {
        const flow = leave.flow || {
          requireTeamLeaderFirst: true,
          stepsJson: [{ kind: "department_leader" }, { kind: "manager" }],
        };
        const steps = effectiveSteps(flow, {
          hasTeam: Boolean(leave.employee?.teamId),
        });
        const idx = Number(leave.currentStepIndex) || 0;
        const kind = steps[idx]?.kind || "department_leader";
        const assignees = await resolveAssignees(context.prisma, {
          HotelName: leave.HotelName,
          kind,
          employee: leave.employee,
        });
        if (assignees.employeeIds.includes(me.id)) out.push(mapLeave(leave));
      }
      return out;
    },

    myPayslips: async (_, __, context) => {
      const employeeId = assertEmployee(context);
      const rows = await context.prisma.hr_payslip.findMany({
        where: { employeeId },
        include: { period: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return rows
        .filter((r) => {
          const st = String(r.period?.status || "");
          // Hide stubs / rejected generate runs (no employee-visible slip yet)
          if (!r.period || st === "pending_generate") return false;
          return true;
        })
        .map((r) => {
          const raw = String(r.paymentStatus || "unpaid");
          // Emp badges: Unpaid until HR mark + Finance confirm; Marked paid after both
          let paymentStatus = "unpaid";
          if (raw === "approved") {
            paymentStatus = "marked_paid";
          } else if (raw === "marked_paid" && r.managerApprovedAt) {
            paymentStatus = "marked_paid";
          } else if (raw === "marked_paid" && !r.managerApprovedAt) {
            // Legacy HR-only mark — still unpaid until Finance confirms
            paymentStatus = "unpaid";
          } else if (raw === "awaiting_finance") {
            paymentStatus = "unpaid";
          } else if (raw === "unpaid") {
            paymentStatus = "unpaid";
          } else {
            paymentStatus = "unpaid";
          }
          return {
            id: r.id,
            payslipNumber: r.payslipNumber || "",
            employeeName: r.employeeName || "",
            netPayETB: r.netPayETB || 0,
            grossSalaryETB: r.grossSalaryETB || 0,
            paymentStatus,
            periodKey: r.period?.periodKey || "",
            monthName: r.period?.monthName || "",
            fromYmd: r.period?.fromYmd || "",
            toYmd: r.period?.toYmd || "",
            createdAt: r.createdAt,
          };
        });
    },

    myAttendance: async (_, { limit }, context) => {
      const employeeId = assertEmployee(context);
      const take = Math.min(Math.max(Number(limit) || 60, 1), 180);
      return context.prisma.hr_attendance.findMany({
        where: { employeeId },
        orderBy: { workDate: "desc" },
        take,
      });
    },

    myIncidents: async (_, { limit }, context) => {
      const employeeId = assertEmployee(context);
      const take = Math.min(Math.max(Number(limit) || 40, 1), 100);
      return context.prisma.hr_incident.findMany({
        where: { employeeId },
        orderBy: [{ occurredYmd: "desc" }, { createdAt: "desc" }],
        take,
      });
    },

    myShifts: async (_, { limit }, context) => {
      const employeeId = assertEmployee(context);
      const take = Math.min(Math.max(Number(limit) || 30, 1), 90);
      return context.prisma.hr_shift.findMany({
        where: { employeeId },
        orderBy: { workDate: "desc" },
        take,
      });
    },
  },

  Mutation: {
    employeeLogin: async (_, { otp }, context) => {
      const attempt = consumeEmployeeLoginAttempt(
        `${context.clientIp || "ip"}:otp`,
      );
      if (!attempt.ok) {
        throw new Error(
          `Too many login attempts — try again in ${attempt.retryAfterSec}s`,
        );
      }
      const normalized = normalizePortalOtp(otp);
      if (!isValidPortalOtpFormat(normalized)) {
        throw new Error("Enter your 6-character portal code (letters and digits)");
      }

      // Globally unique among active portal employees (like lodging guestOtp).
      const matched = await context.prisma.hr_employee.findFirst({
        where: {
          portalOtpLookup: normalized,
          status: { not: "terminated" },
          portalOtpHash: { not: "" },
        },
      });
      if (
        !matched ||
        !(await verifyPortalOtp(normalized, matched.portalOtpHash))
      ) {
        throw new Error("Invalid portal code");
      }

      const isFirstLogin = !matched.portalFirstLoginAt;
      const data = {
        ...(isFirstLogin
          ? {
              portalFirstLoginAt: new Date(),
              ...clearOtpPreviewFields(),
            }
          : {}),
      };
      const updated =
        Object.keys(data).length > 0
          ? await context.prisma.hr_employee.update({
              where: { id: matched.id },
              data,
            })
          : matched;

      const tinNumber = await resolveTinForHotel(
        context.prisma,
        updated.HotelName,
      );
      const token = signEmployeeToken({
        employeeId: updated.id,
        HotelName: updated.HotelName,
        tinNumber,
        fullName: updated.fullName,
      });
      return { token, employee: publicEmployee(updated) };
    },

    changeOwnOtp: async (_, { currentOtp, newOtp }, context) => {
      const employeeId = assertEmployee(context);
      const row = await loadMe(context.prisma, employeeId);
      const cur = normalizePortalOtp(currentOtp);
      const next = normalizePortalOtp(newOtp);
      if (!isValidPortalOtpFormat(next)) {
        throw new Error("New code must be 6 alphanumeric characters");
      }
      if (!(await verifyPortalOtp(cur, row.portalOtpHash))) {
        throw new Error("Current portal code is incorrect");
      }
      if (cur === next) {
        throw new Error("Choose a different portal code");
      }
      if (
        await isPortalOtpTaken(context.prisma, next, {
          excludeEmployeeId: employeeId,
        })
      ) {
        throw new Error("That portal code is already in use — choose another");
      }
      const portalOtpHash = await hashPortalOtp(next);
      await context.prisma.hr_employee.update({
        where: { id: employeeId },
        data: {
          portalOtpHash,
          portalOtpLookup: next,
          mustChangeOtp: false,
          ...clearOtpPreviewFields(),
        },
      });
      return true;
    },

    markOwnNotificationRead: async (_, { id }, context) => {
      const employeeId = assertEmployee(context);
      const note = await context.prisma.hr_notification.findFirst({
        where: { id: Number(id), employeeId },
      });
      if (!note) throw new Error("Notification not found");
      if (note.readAt) return note;
      return context.prisma.hr_notification.update({
        where: { id: note.id },
        data: { readAt: new Date() },
      });
    },

    updateOwnProfile: async (_, { profileImageUrl, phone, email }, context) => {
      const employeeId = assertEmployee(context);
      const data = {};
      if (profileImageUrl != null) {
        data.profileImageUrl = String(profileImageUrl).trim().slice(0, 500);
      }
      if (phone != null) {
        data.phone = String(phone).trim().slice(0, 40);
      }
      if (email != null) {
        const next = String(email).trim().slice(0, 120);
        if (next && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
          throw new Error("Enter a valid email address");
        }
        data.email = next;
      }
      if (Object.keys(data).length === 0) {
        const current = await loadMe(context.prisma, employeeId);
        return publicEmployee(current);
      }
      const updated = await context.prisma.hr_employee.update({
        where: { id: employeeId },
        data,
      });
      return publicEmployee(updated);
    },

    createOwnLeaveRequest: async (
      _,
      { leaveType, fromYmd, toYmd, days, reason },
      context,
    ) => {
      const me = await loadMe(context.prisma, assertEmployee(context));
      await assertEmployeeCanRequestLeave(context.prisma, me);
      const lt = String(leaveType ?? "").trim();
      if (!lt) throw new Error("Leave type is required");
      const typeRow = await context.prisma.hr_leave_type.findFirst({
        where: { HotelName: me.HotelName, code: lt, active: true },
      });
      if (!typeRow) throw new Error("Invalid leave type");
      const from = assertYmd(fromYmd, "fromYmd");
      const to = assertYmd(toYmd, "toYmd");
      if (to < from) throw new Error("toYmd must not be before fromYmd");
      const d = days != null ? Number(days) : 1;
      if (!(d > 0)) throw new Error("days must be positive");

      const account = await context.prisma.tenant_account.findFirst({
        where: {
          OR: [{ hotelDisplayName: me.HotelName }, { tinNumber: me.HotelName }],
        },
        select: { hrSoloManagerEnabled: true },
      });
      const prep = await prepareLeaveFlowAttachment(context.prisma, {
        employee: me,
        businessType: "",
        hrSoloManagerEnabled: Boolean(account?.hrSoloManagerEnabled),
      });

      const created = await context.prisma.hr_leave_request.create({
        data: {
          HotelName: me.HotelName,
          employeeId: me.id,
          leaveType: lt,
          fromYmd: from,
          toYmd: to,
          days: round2(d),
          reason: String(reason ?? "").trim(),
          status: "pending",
          flowId: prep.flowId,
          currentStepIndex: prep.currentStepIndex,
        },
        include: { employee: true },
      });
      await recordEscalations(context.prisma, {
        HotelName: me.HotelName,
        requestId: created.id,
        steps: prep.steps,
        escalatedKinds: prep.escalatedKinds,
      });
      return mapLeave(created);
    },

    decideLeaveAsAssignee: async (_, { id, approve, note }, context) => {
      const me = await loadMe(context.prisma, assertEmployee(context));
      const leave = await context.prisma.hr_leave_request.findUnique({
        where: { id: Number(id) },
        include: { employee: true },
      });
      if (!leave || leave.HotelName !== me.HotelName) {
        throw new Error("Leave request not found");
      }
      const updated = await decideLeaveOnEngine(context.prisma, {
        leave,
        approve: Boolean(approve),
        actor: { employeeId: me.id, name: me.fullName },
        note,
        onFinalApprove: async (row) => {
          const typeRow = await context.prisma.hr_leave_type.findFirst({
            where: { HotelName: row.HotelName, code: row.leaveType },
          });
          if (typeRow?.paid) {
            const balance = await context.prisma.hr_leave_balance.findUnique({
              where: {
                employeeId_leaveType: {
                  employeeId: row.employeeId,
                  leaveType: row.leaveType,
                },
              },
            });
            const nextBalance = round2(
              (balance ? Number(balance.balanceDays) : 0) - Number(row.days),
            );
            await context.prisma.hr_leave_balance.upsert({
              where: {
                employeeId_leaveType: {
                  employeeId: row.employeeId,
                  leaveType: row.leaveType,
                },
              },
              create: {
                HotelName: row.HotelName,
                employeeId: row.employeeId,
                leaveType: row.leaveType,
                balanceDays: nextBalance,
              },
              update: { balanceDays: nextBalance },
            });
          }
        },
      });
      if (
        updated.status === "approved" ||
        updated.status === "rejected"
      ) {
        await notifyEmployeeLeaveDecision(context.prisma, updated, {
          createdBy: me.fullName,
        });
      }
      return mapLeave(updated);
    },
  },
};
