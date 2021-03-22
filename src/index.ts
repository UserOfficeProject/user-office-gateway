import 'dotenv/config';

import 'reflect-metadata';
import {
  ApolloGateway,
  RemoteGraphQLDataSource,
  ServiceEndpointDefinition,
} from '@apollo/gateway';
import { logger } from '@esss-swap/duo-logger';
import { ApolloServer } from 'apollo-server';

import AuthProvider, {
  AuthJwtPayload,
  AuthJwtApiTokenPayload,
} from './AuthProvider';

type ServiceEndpoint = ServiceEndpointDefinition & {
  includeAuthJwt: boolean;
};

type AppContext = {
  authJwtPayload: AuthJwtPayload | AuthJwtApiTokenPayload | null;
  authToken: string | null;
};

const extractTokenFromHeader = (header: string | null): string | null => {
  if (!header) {
    return null;
  }

  const [, token] = header.split(' ');

  return token ?? null;
};

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const authProvider = new AuthProvider(process.env.USER_OFFICE_BACKEND!);

async function bootstrap() {
  const serviceList: ServiceEndpoint[] = [
    {
      name: 'user-office',
      url: process.env.USER_OFFICE_BACKEND,
      includeAuthJwt: false,
    },
    {
      name: 'user-office-scheduler',
      url: process.env.USER_OFFICE_SCHEDULER_BACKEND,
      includeAuthJwt: true,
    },
  ];

  const gateway = new ApolloGateway({
    serviceList,

    // in development poll frequently to detect any schema changes
    // used by the docker-compose file in user-office core
    // eslint-disable-next-line @typescript-eslint/camelcase
    experimental_pollInterval:
      process.env.ENABLE_SERVICE_POLLING === '1' ? 5000 : 0,

    buildService(params) {
      const { url, name, includeAuthJwt } = params as ServiceEndpoint;

      logger.logInfo(`Registering service: '${name}' (${url})`, {
        includeAuthJwt,
      });

      return new RemoteGraphQLDataSource<Partial<AppContext>>({
        url,
        willSendRequest({ request, context }) {
          if (includeAuthJwt) {
            const encodedPayload = Buffer.from(
              JSON.stringify(context.authJwtPayload) || ''
            ).toString('base64');

            request.http?.headers.set('x-auth-jwt-payload', encodedPayload);
          }

          // include the token as we may call the core directly from the scheduler
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

      let authJwtPayload: AuthJwtPayload | AuthJwtApiTokenPayload | null = null;
      if (authToken) {
        const { isValid, payload } = await authProvider.checkToken(authToken);

        if (isValid && payload) {
          authJwtPayload = payload;
        }
      }

      return { authJwtPayload, authToken };
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const port = +process.env.GATEWAY_PORT! || 4100;

  server.listen({ port }).then(({ url }) => {
    logger.logInfo(`Apollo Gateway ready at ${url}`, {});
  });
}

let exits = 0;

// it's possible the services aren't only yet, so be patient and wait and retry
function retry() {
  bootstrap().catch(e => {
    logger.logException(`Api gateway error (tries: ${exits})`, e);

    if (process.env.KEEP_RETRYING !== '1' && exits >= 5) {
      process.exit(1);
    }

    setTimeout(() => {
      exits++;
      retry();
    }, 15 * 1000);
  });
}

retry();
