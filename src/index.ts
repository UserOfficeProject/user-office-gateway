import 'dotenv/config';

import 'reflect-metadata';
import {
  ApolloGateway,
  IntrospectAndCompose,
  RemoteGraphQLDataSource,
  ServiceEndpointDefinition,
} from '@apollo/gateway';
import { ApolloServer, BaseContext, ContextFunction } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import {
  StandaloneServerContextFunctionArgument,
  startStandaloneServer,
} from '@apollo/server/standalone';
import { logger } from '@user-office-software/duo-logger';

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

const context: ContextFunction<
  [StandaloneServerContextFunctionArgument],
  BaseContext
> = async ({ req }): Promise<AppContext> => {
  // Note: this runs only for incoming requests
  // during initialization this part won't run
  // so make sure when you try to access `context` in `RemoteGraphQLDataSource`
  // you except the property to be undefined on startup

  const authHeader = req.headers['authorization'] ?? null;
  const authToken = extractTokenFromHeader(authHeader);

  let authJwtPayload: AuthJwtPayload | AuthJwtApiTokenPayload | null = null;
  if (authToken) {
    const { isValid, payload } = await authProvider.checkToken(authToken);

    if (isValid && payload) {
      authJwtPayload = payload;
    }
  }

  return { authJwtPayload, authToken };
};

async function bootstrap() {
  const subgraphs: ServiceEndpoint[] = [
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
    // TODO: IntrospectAndCompose shouldn't be used in production: https://www.apollographql.com/docs/apollo-server/using-federation/apollo-gateway-setup/#composing-subgraphs-with-introspectandcompose
    supergraphSdl: new IntrospectAndCompose({
      subgraphs,
    }),
    // // in development poll frequently to detect any schema changes
    // // used by the docker-compose file in user-office core
    pollIntervalInMs: process.env.ENABLE_SERVICE_POLLING === '1' ? 5000 : 0,
    buildService(params) {
      const { url, name, includeAuthJwt } = params as ServiceEndpoint;

      logger.logInfo(`Registering service: '${name}' (${url})`, {
        includeAuthJwt,
      });

      return new RemoteGraphQLDataSource<AppContext>({
        url,
        willSendRequest({ request, context }) {
          if (includeAuthJwt && 'authJwtPayload' in context) {
            const encodedPayload = Buffer.from(
              JSON.stringify(context.authJwtPayload) || ''
            ).toString('base64');

            request.http?.headers.set('x-auth-jwt-payload', encodedPayload);
          }

          // include the token as we may call the core directly from the scheduler
          if ('authToken' in context && context.authToken) {
            request.http?.headers.set(
              'authorization',
              `Bearer ${context.authToken}`
            );
          }
        },
      });
    },
  });

  const server = new ApolloServer({
    gateway,
    plugins: [
      process.env.NODE_ENV === 'production'
        ? ApolloServerPluginLandingPageDisabled()
        : ApolloServerPluginLandingPageLocalDefault({
            footer: false,
            embed: { initialState: { pollForSchemaUpdates: false } },
          }),
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const port = +process.env.GATEWAY_PORT! || 4100;

  const { url } = await startStandaloneServer(server, {
    context,
    listen: { port },
  });
  logger.logInfo(`Apollo Gateway ready at ${url}`, {});

  // because of an unfortunate bug/behavior if polling is enabled (or not?) and the schema isn't available
  // it will stop trying to resolve the schema
  // as a workaround explicitly check the status and throw error if the schema is not available
  await gateway.serviceHealthCheck().catch(async (err) => {
    await server.stop();

    return Promise.reject(err);
  });
}

let exits = 0;

// it's possible the services aren't only yet, so be patient and wait and retry
function retry() {
  bootstrap().catch((e) => {
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
