import { gql } from "apollo-server-express";
import {
  employeeMutationFields,
  employeeQueryFields,
  employeeTypeDefs,
} from "./employeeGraphql.js";
import {
  empChatMutationFields,
  empChatQueryFields,
  empChatTypeDefs,
} from "./employeeChatGraphql.js";

export const typeDefs = gql`
  scalar DateTime
  scalar JSON

  ${employeeTypeDefs}
  ${empChatTypeDefs}

  type Query {
    _health: String
    ${employeeQueryFields}
    ${empChatQueryFields}
  }

  type Mutation {
    _noop: Boolean
    ${employeeMutationFields}
    ${empChatMutationFields}
  }
`;
