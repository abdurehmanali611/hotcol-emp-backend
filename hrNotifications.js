/**
 * Emp-side helper to write hr_notification rows (same table as hotcol-user).
 */

export async function createHrNotification(
  prisma,
  {
    HotelName,
    recipientRole = "",
    employeeId = null,
    kind,
    title,
    body,
    href = "",
    actionStatus = "",
    createdBy = "",
  },
) {
  const hotel = String(HotelName ?? "").trim();
  if (!hotel) throw new Error("HotelName is required for notification");
  const k = String(kind ?? "").trim();
  if (!k) throw new Error("Notification kind is required");
  const t = String(title ?? "").trim();
  if (!t) throw new Error("Notification title is required");

  return prisma.hr_notification.create({
    data: {
      HotelName: hotel,
      recipientRole: String(recipientRole ?? "").trim(),
      employeeId:
        employeeId != null && Number(employeeId) > 0 ? Number(employeeId) : null,
      kind: k,
      title: t,
      body: String(body ?? "").trim(),
      href: String(href ?? "").trim(),
      actionStatus: String(actionStatus ?? "").trim(),
      createdBy: String(createdBy ?? "").trim(),
    },
  });
}

/** Notify the leave requester when the request is finally approved or rejected. */
export async function notifyEmployeeLeaveDecision(
  prisma,
  leave,
  { createdBy = "" } = {},
) {
  const status = String(leave?.status || "");
  if (status !== "approved" && status !== "rejected") return null;
  const approved = status === "approved";
  return createHrNotification(prisma, {
    HotelName: leave.HotelName,
    employeeId: leave.employeeId,
    kind: approved ? "leave_approved" : "leave_rejected",
    title: approved ? "Leave approved" : "Leave rejected",
    body: `Your ${leave.leaveType || "leave"} request (${leave.fromYmd} → ${leave.toYmd}) was ${status}.`,
    href: "/leave",
    createdBy,
  });
}
