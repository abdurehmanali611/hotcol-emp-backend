import { DateTimeResolver, GraphQLJSON } from "graphql-scalars";
import { assertEmployee } from "./lib/employeeAuth.js";
import { employeeResolvers } from "./employeeGraphql.js";
import { createEmpChatResolvers } from "./employeeChatGraphql.js";

async function loadMe(prisma, employeeId) {
  const row = await prisma.hr_employee.findUnique({ where: { id: employeeId } });
  if (!row) throw new Error("Employee not found");
  return row;
}

const empChatResolvers = createEmpChatResolvers({ assertEmployee, loadMe });

export const resolvers = {
  DateTime: DateTimeResolver,
  JSON: GraphQLJSON,
  Query: {
    _health: () => "HotCol Employee GraphQL API is running",
    ...employeeResolvers.Query,
    ...empChatResolvers.Query,
  },
  Mutation: {
    _noop: () => true,
    ...employeeResolvers.Mutation,
    ...empChatResolvers.Mutation,
  },
};
