import { request, gql } from 'graphql-request';

export type Role = {
  shortCode: string;
};

export type User = {
  id: string;
  email: string;
};

export type AuthJwtPayload = { user: User; roles: Role[]; currentRole: Role };

export default class AuthProvider {
  constructor(private url: string) {}

  async checkToken(token: string) {
    const query = gql`
      query checkToken($token: String!) {
        checkToken(token: $token) {
          isValid
          payload {
            user {
              id
              email
            }
            roles {
              shortCode
            }
          }
        }
      }
    `;

    const result = await request<{
      checkToken: { isValid: boolean; payload: AuthJwtPayload };
    }>(this.url, query, {
      token,
    });

    return result.checkToken;
  }
}
