/**
 * Employee-portal chat: emp↔emp and emp↔manager (HR Module).
 */

const MANAGER_MEMBER_KEY = "m";

function memberKeyForEmployee(employeeId) {
  return `e:${Number(employeeId)}`;
}

function mapMember(row) {
  return {
    id: row.id,
    threadId: row.threadId,
    employeeId: row.employeeId ?? null,
    isManager: Boolean(row.isManager),
    memberKey: row.memberKey,
    joinedAt: row.joinedAt,
    lastReadAt: row.lastReadAt ?? null,
    employeeName: row.employeeName || null,
  };
}

function mapMessage(row) {
  const senderEmployeeId =
    row.senderEmployeeId != null ? Number(row.senderEmployeeId) : null;
  const fromEmployee = senderEmployeeId != null && senderEmployeeId > 0;
  const senderIsManager = fromEmployee
    ? false
    : row.senderIsManager === true ||
      row.senderIsManager === 1 ||
      row.senderIsManager === "1";
  return {
    id: row.id,
    threadId: row.threadId,
    senderEmployeeId: fromEmployee ? senderEmployeeId : null,
    senderIsManager,
    body: row.body || "",
    createdAt: row.createdAt,
    imageUrl: String(row.imageUrl || "").trim(),
    senderName: fromEmployee
      ? row.senderName || "Employee"
      : senderIsManager
        ? "Manager"
        : row.senderName || "Employee",
  };
}

function mapThread(row) {
  return {
    id: row.id,
    HotelName: row.HotelName,
    kind: row.kind,
    title: row.title || "",
    createdByEmployeeId: row.createdByEmployeeId ?? null,
    createdByManagerUserId: row.createdByManagerUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    members: (row.members || []).map(mapMember),
    lastMessage: row.messages?.[0] ? mapMessage(row.messages[0]) : null,
    messageCount: row._count?.messages ?? null,
  };
}

async function enrichMembers(prisma, members) {
  const ids = members
    .map((m) => m.employeeId)
    .filter((id) => id != null)
    .map(Number);
  const emps = ids.length
    ? await prisma.hr_employee.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true },
      })
    : [];
  const nameById = new Map(emps.map((e) => [e.id, e.fullName]));
  return members.map((m) => ({
    ...m,
    employeeName: m.isManager
      ? "Manager"
      : nameById.get(Number(m.employeeId)) || null,
  }));
}

async function enrichMessages(prisma, messages) {
  const ids = [
    ...new Set(
      (messages || [])
        .map((m) =>
          m.senderEmployeeId != null ? Number(m.senderEmployeeId) : null,
        )
        .filter((id) => id != null && id > 0),
    ),
  ];
  const emps = ids.length
    ? await prisma.hr_employee.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true },
      })
    : [];
  const nameById = new Map(emps.map((e) => [e.id, e.fullName]));
  return (messages || []).map((m) => {
    const empId =
      m.senderEmployeeId != null ? Number(m.senderEmployeeId) : null;
    const fromEmployee = empId != null && empId > 0;
    return mapMessage({
      ...m,
      senderEmployeeId: fromEmployee ? empId : null,
      senderIsManager: fromEmployee ? false : m.senderIsManager,
      senderName: fromEmployee
        ? nameById.get(empId) || "Employee"
        : undefined,
    });
  });
}

const threadInclude = {
  members: true,
  messages: { orderBy: { createdAt: "desc" }, take: 1 },
  _count: { select: { messages: true } },
};

export const empChatTypeDefs = `
  type EmpChatMember {
    id: Int!
    threadId: Int!
    employeeId: Int
    isManager: Boolean!
    memberKey: String!
    joinedAt: DateTime!
    lastReadAt: DateTime
    employeeName: String
  }

  type EmpChatMessage {
    id: Int!
    threadId: Int!
    senderEmployeeId: Int
    senderIsManager: Boolean!
    body: String!
    imageUrl: String!
    createdAt: DateTime!
    senderName: String!
  }

  type EmpChatThread {
    id: Int!
    HotelName: String!
    kind: String!
    title: String!
    createdByEmployeeId: Int
    createdByManagerUserId: Int
    createdAt: DateTime!
    updatedAt: DateTime!
    members: [EmpChatMember!]!
    lastMessage: EmpChatMessage
    messageCount: Int
  }

  type EmpChatPeer {
    id: Int!
    fullName: String!
    department: String!
    jobTitle: String!
  }
`;

export const empChatQueryFields = `
  myChatThreads: [EmpChatThread!]!
  myChatMessages(threadId: Int!, limit: Int): [EmpChatMessage!]!
  myChatUnreadCount: Int!
  myChatPeers: [EmpChatPeer!]!
`;

export const empChatMutationFields = `
  createMyChatDirect(peerEmployeeId: Int!, withManager: Boolean): EmpChatThread!
  createMyChatWithManager: EmpChatThread!
  createMyChatGroup(title: String, peerEmployeeIds: [Int!]!, withManager: Boolean): EmpChatThread!
  sendMyChatMessage(threadId: Int!, body: String, imageUrl: String): EmpChatMessage!
  markMyChatThreadRead(threadId: Int!): EmpChatThread!
`;

export function createEmpChatResolvers({ assertEmployee, loadMe }) {
  async function loadBlocks(prisma, HotelName) {
    if (!prisma?.hr_chat_block?.findMany) {
      throw new Error(
        "Chat is not ready on this server — restart the employee API after prisma generate",
      );
    }
    return prisma.hr_chat_block.findMany({ where: { HotelName } });
  }

  function pairBlocked(blocks, empA, empB) {
    const a = Number(empA);
    const b = Number(empB);
    for (const bl of blocks) {
      if (bl.pathType !== "emp_emp") continue;
      const x = Number(bl.employeeIdA);
      const y = Number(bl.employeeIdB);
      if ((x === a && y === b) || (x === b && y === a)) return true;
    }
    return false;
  }

  function managerBlockedFor(blocks, employeeId) {
    const e = Number(employeeId);
    return blocks.some(
      (bl) => bl.pathType === "emp_manager" && Number(bl.employeeIdA) === e,
    );
  }

  function assertCanStart(blocks, meId, peerIds, withManager) {
    for (const peer of peerIds) {
      if (pairBlocked(blocks, meId, peer)) {
        throw new Error("Chat with this coworker is blocked by management");
      }
    }
    for (let i = 0; i < peerIds.length; i++) {
      for (let j = i + 1; j < peerIds.length; j++) {
        if (pairBlocked(blocks, peerIds[i], peerIds[j])) {
          throw new Error("A chat block prevents this group");
        }
      }
    }
    if (withManager && managerBlockedFor(blocks, meId)) {
      throw new Error("Chat with Manager is blocked for you");
    }
  }

  async function assertMember(prisma, threadId, employeeId) {
    const member = await prisma.hr_chat_member.findFirst({
      where: {
        threadId: Number(threadId),
        memberKey: memberKeyForEmployee(employeeId),
      },
    });
    if (!member) throw new Error("Thread not found");
    return member;
  }

  async function mapThreadEnriched(prisma, row) {
    const members = await enrichMembers(prisma, row.members || []);
    const messages = row.messages?.length
      ? await enrichMessages(prisma, row.messages)
      : [];
    return mapThread({ ...row, members, messages });
  }

  return {
    Query: {
      myChatThreads: async (_, __, context) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        const rows = await context.prisma.hr_chat_thread.findMany({
          where: {
            HotelName: me.HotelName,
            members: {
              some: { memberKey: memberKeyForEmployee(me.id) },
            },
          },
          include: threadInclude,
          orderBy: { updatedAt: "desc" },
          take: 100,
        });
        return Promise.all(
          rows.map((r) => mapThreadEnriched(context.prisma, r)),
        );
      },

      myChatMessages: async (_, { threadId, limit }, context) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        await assertMember(context.prisma, threadId, me.id);
        const rows = await context.prisma.hr_chat_message.findMany({
          where: { threadId: Number(threadId) },
          orderBy: { createdAt: "asc" },
          take: Math.min(Number(limit) || 200, 500),
        });
        return enrichMessages(context.prisma, rows);
      },

      myChatUnreadCount: async (_, __, context) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        const memberships = await context.prisma.hr_chat_member.findMany({
          where: {
            memberKey: memberKeyForEmployee(me.id),
            thread: { HotelName: me.HotelName },
          },
          select: { threadId: true, lastReadAt: true },
        });
        let unreadThreads = 0;
        for (const m of memberships) {
          const count = await context.prisma.hr_chat_message.count({
            where: {
              threadId: m.threadId,
              NOT: {
                AND: [
                  { senderEmployeeId: me.id },
                  { senderIsManager: false },
                ],
              },
              ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}),
            },
          });
          if (count > 0) unreadThreads += 1;
        }
        return unreadThreads;
      },

      myChatPeers: async (_, __, context) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        const rows = await context.prisma.hr_employee.findMany({
          where: {
            HotelName: me.HotelName,
            status: { not: "terminated" },
            id: { not: me.id },
          },
          orderBy: { fullName: "asc" },
          take: 500,
          select: {
            id: true,
            fullName: true,
            department: true,
            jobTitle: true,
          },
        });
        return rows.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          department: r.department || "",
          jobTitle: r.jobTitle || "",
        }));
      },
    },

    Mutation: {
      createMyChatWithManager: async (_, __, context) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        const blocks = await loadBlocks(context.prisma, me.HotelName);
        if (managerBlockedFor(blocks, me.id)) {
          throw new Error("Chat with Manager is blocked for you");
        }
        const existing = await context.prisma.hr_chat_thread.findFirst({
          where: {
            HotelName: me.HotelName,
            kind: "direct",
            AND: [
              {
                members: {
                  some: { memberKey: memberKeyForEmployee(me.id) },
                },
              },
              {
                members: {
                  some: { memberKey: MANAGER_MEMBER_KEY },
                },
              },
              {
                members: {
                  none: {
                    AND: [
                      { isManager: false },
                      { employeeId: { not: me.id } },
                    ],
                  },
                },
              },
            ],
          },
          include: threadInclude,
        });
        if (existing) {
          return mapThreadEnriched(context.prisma, existing);
        }
        const created = await context.prisma.hr_chat_thread.create({
          data: {
            HotelName: me.HotelName,
            kind: "direct",
            title: "Manager",
            createdByEmployeeId: me.id,
            members: {
              create: [
                {
                  employeeId: me.id,
                  isManager: false,
                  memberKey: memberKeyForEmployee(me.id),
                },
                {
                  employeeId: null,
                  isManager: true,
                  memberKey: MANAGER_MEMBER_KEY,
                },
              ],
            },
          },
          include: threadInclude,
        });
        return mapThreadEnriched(context.prisma, created);
      },

      createMyChatDirect: async (
        _,
        { peerEmployeeId, withManager },
        context,
      ) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        const peerId = Number(peerEmployeeId);
        if (!(peerId > 0) || peerId === me.id) {
          throw new Error("Pick another employee");
        }
        const peer = await context.prisma.hr_employee.findFirst({
          where: {
            id: peerId,
            HotelName: me.HotelName,
            status: { not: "terminated" },
          },
        });
        if (!peer) throw new Error("Employee not found");
        const includeMgr = Boolean(withManager);
        const blocks = await loadBlocks(context.prisma, me.HotelName);
        assertCanStart(blocks, me.id, [peerId], includeMgr);

        const existing = await context.prisma.hr_chat_thread.findFirst({
          where: {
            HotelName: me.HotelName,
            kind: "direct",
            AND: [
              {
                members: {
                  some: { memberKey: memberKeyForEmployee(me.id) },
                },
              },
              {
                members: {
                  some: { memberKey: memberKeyForEmployee(peerId) },
                },
              },
              includeMgr
                ? {
                    members: {
                      some: { memberKey: MANAGER_MEMBER_KEY },
                    },
                  }
                : {
                    members: {
                      none: { memberKey: MANAGER_MEMBER_KEY },
                    },
                  },
            ],
          },
          include: threadInclude,
        });
        if (existing) {
          return mapThreadEnriched(context.prisma, existing);
        }

        const title = includeMgr
          ? `${me.fullName}, ${peer.fullName} & Manager`
          : peer.fullName;
        const created = await context.prisma.hr_chat_thread.create({
          data: {
            HotelName: me.HotelName,
            kind: "direct",
            title,
            createdByEmployeeId: me.id,
            members: {
              create: [
                {
                  employeeId: me.id,
                  isManager: false,
                  memberKey: memberKeyForEmployee(me.id),
                },
                {
                  employeeId: peerId,
                  isManager: false,
                  memberKey: memberKeyForEmployee(peerId),
                },
                ...(includeMgr
                  ? [
                      {
                        employeeId: null,
                        isManager: true,
                        memberKey: MANAGER_MEMBER_KEY,
                      },
                    ]
                  : []),
              ],
            },
          },
          include: threadInclude,
        });
        return mapThreadEnriched(context.prisma, created);
      },

      createMyChatGroup: async (
        _,
        { title, peerEmployeeIds, withManager },
        context,
      ) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        const peers = [
          ...new Set((peerEmployeeIds || []).map(Number)),
        ].filter((id) => id > 0 && id !== me.id);
        if (peers.length < 1) throw new Error("Add at least one coworker");
        const includeMgr = Boolean(withManager);
        const blocks = await loadBlocks(context.prisma, me.HotelName);
        assertCanStart(blocks, me.id, peers, includeMgr);

        const allIds = [me.id, ...peers];
        const created = await context.prisma.hr_chat_thread.create({
          data: {
            HotelName: me.HotelName,
            kind: "group",
            title:
              String(title || "").trim().slice(0, 120) ||
              `Group (${allIds.length})`,
            createdByEmployeeId: me.id,
            members: {
              create: [
                ...allIds.map((id) => ({
                  employeeId: id,
                  isManager: false,
                  memberKey: memberKeyForEmployee(id),
                })),
                ...(includeMgr
                  ? [
                      {
                        employeeId: null,
                        isManager: true,
                        memberKey: MANAGER_MEMBER_KEY,
                      },
                    ]
                  : []),
              ],
            },
          },
          include: threadInclude,
        });
        return mapThreadEnriched(context.prisma, created);
      },

      sendMyChatMessage: async (_, { threadId, body, imageUrl }, context) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        const text = String(body || "").trim().slice(0, 4000);
        const image = String(imageUrl || "").trim().slice(0, 2000);
        if (!text && !image) throw new Error("Message or image required");
        await assertMember(context.prisma, threadId, me.id);

        const thread = await context.prisma.hr_chat_thread.findUnique({
          where: { id: Number(threadId) },
          include: { members: true },
        });
        if (!thread || thread.HotelName !== me.HotelName) {
          throw new Error("Thread not found");
        }

        const blocks = await loadBlocks(context.prisma, me.HotelName);
        const peerIds = thread.members
          .filter((m) => !m.isManager && Number(m.employeeId) !== me.id)
          .map((m) => Number(m.employeeId));
        const hasManager = thread.members.some((m) => m.isManager);
        // Sending into an existing thread: still enforce blocks
        for (const peer of peerIds) {
          if (pairBlocked(blocks, me.id, peer)) {
            throw new Error("This chat is blocked");
          }
        }
        if (hasManager && managerBlockedFor(blocks, me.id)) {
          throw new Error("Chat with Manager is blocked for you");
        }

        const msg = await context.prisma.hr_chat_message.create({
          data: {
            threadId: thread.id,
            senderEmployeeId: me.id,
            senderIsManager: false,
            body: text,
            imageUrl: image,
          },
        });
        await context.prisma.hr_chat_thread.update({
          where: { id: thread.id },
          data: { updatedAt: new Date() },
        });
        const [enriched] = await enrichMessages(context.prisma, [msg]);
        return mapMessage(enriched);
      },

      markMyChatThreadRead: async (_, { threadId }, context) => {
        const me = await loadMe(context.prisma, assertEmployee(context));
        await assertMember(context.prisma, threadId, me.id);
        await context.prisma.hr_chat_member.updateMany({
          where: {
            threadId: Number(threadId),
            memberKey: memberKeyForEmployee(me.id),
          },
          data: { lastReadAt: new Date() },
        });
        const row = await context.prisma.hr_chat_thread.findUnique({
          where: { id: Number(threadId) },
          include: threadInclude,
        });
        return mapThreadEnriched(context.prisma, row);
      },
    },
  };
}
