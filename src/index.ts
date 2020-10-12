import 'dotenv/config';

import 'reflect-metadata';
import {
  ApolloGateway,
  RemoteGraphQLDataSource,
  ServiceEndpointDefinition,
} from '@apollo/gateway';
import { logger } from '@esss-swap/duo-logger';
import { ApolloServer } from 'apollo-server';
import { request, gql } from 'graphql-request';

type ServiceEndpoint = ServiceEndpointDefinition & {
  authCheck: boolean;
};

// just a simple example
interface AppContext {
  authToken: string | null;
  isValidToken: boolean;
}

const extractTokenFromHeader = (header: string | null): string | null => {
  if (!header) {
    return null;
  }

  const [, token] = header.split(' ');

  return token ?? null;
};

class AuthProvider {
  constructor(private url: string) {}

  async checkToken(token: string) {
    const query = gql`
      query checkToken($token: String!) {
        checkToken(token: $token) {
          isValid
        }
      }
    `;

    const result = await request<{ checkToken: { isValid: boolean } }>(
      this.url,
      query,
      {
        token,
      }
    );

    return result.checkToken.isValid;
  }
}

const authProvider = new AuthProvider(process.env.USER_OFFICE_BACKEND!);

async function bootstrap() {
  const serviceList: ServiceEndpoint[] = [
    // example
    // the list or the url could come from config / env
    // { name: 'service-name', url: 'http://localhost:4001' },
    {
      name: 'user-office',
      url: process.env.USER_OFFICE_BACKEND,
      authCheck: false,
    },
    {
      name: 'user-office-scheduler',
      url: process.env.USER_OFFICE_SCHEDULER_BACKEND,
      authCheck: true,
    },
  ];

  const gateway = new ApolloGateway({
    serviceList,

    buildService(params) {
      const { url, name, authCheck } = params as ServiceEndpoint;

      logger.logInfo(`Registering service: '${name}' (${url})`, { authCheck });

      return new RemoteGraphQLDataSource<Partial<AppContext>>({
        url,
        willSendRequest({ request, context }) {
          if (authCheck && context?.isValidToken === false) {
            throw new Error('Not authorized');
          }

          if (context.authToken) {
            request.http?.headers.set(
              'authorization',
              `Bearer ${context.authToken}`
            );
          }
        },
      });
    },
  });

  const { schema, executor } = await gateway.load();

  const server = new ApolloServer({
    schema,
    executor,
    playground: true, // TODO: probably we don't want this in prod
    subscriptions: false,
    context: async ({ req }): Promise<AppContext> => {
      // Note: this runs only for incoming requests
      // during initialization this part won't run
      // so make sure when you try to access `context` in `RemoteGraphQLDataSource`
      // you except the property to be undefined on startup

      const authHeader = req.header('authorization') ?? null;
      const authToken = extractTokenFromHeader(authHeader);

      let isValidToken = false;
      if (authToken) {
        isValidToken = await authProvider.checkToken(authToken);
      }

      return { authToken, isValidToken };
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const port = +process.env.GATEWAY_PORT! || 4100;

  server.listen({ port }).then(({ url }) => {
    // TODO: way may want to reuse the same GrayLogger implementation we already have
    // but first we should port it to a standalone util package
    logger.logInfo(`Apollo Gateway ready at ${url}`, {});
  });
}

let exits = 0;

// it's possible the services aren't only yet, so be patient and wait and retry
function retry() {
  bootstrap().catch(e => {
    logger.logError(`Api gateway error (tries: ${exits})`, e);

    if (exits >= 5) {
      process.exit(1);
    }

    setTimeout(() => {
      exits++;
      retry();
    }, 15 * 1000);
  });
}

retry();
