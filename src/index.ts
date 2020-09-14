import 'dotenv/config';

import 'reflect-metadata';
import {
  ApolloGateway,
  RemoteGraphQLDataSource,
  ServiceEndpointDefinition,
} from '@apollo/gateway';
import { logger } from '@esss-swap/duo-logger';
import { ApolloServer } from 'apollo-server';

// just a simple example
interface AppContext {
  userId: string;
}

async function bootstrap() {
  const serviceList: ServiceEndpointDefinition[] = [
    // example
    // the list or the url could come from config / env
    // { name: 'service-name', url: 'http://localhost:4001' },
    { name: 'user-office', url: process.env.USER_OFFICE_BACKEND },
    {
      name: 'user-office-scheduler',
      url: process.env.USER_OFFICE_SCHEDULER_BACKEND,
    },
  ];

  const gateway = new ApolloGateway({
    serviceList,

    buildService({ url, name }) {
      logger.logInfo(`Registering service: '${name}' (${url})`, {});

      return new RemoteGraphQLDataSource<Partial<AppContext>>({
        url,
        willSendRequest({ request, context }) {
          request.http?.headers.set(
            'user-id',
            context?.userId || '<anonymous>'
          );
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
    context: ({ req }): AppContext => {
      // Note: this runs only for incoming requests
      // during initialization this part won't run
      // so make sure when you try to access `context` in `RemoteGraphQLDataSource`
      // you except the property to be undefined on startup

      // just a simple example, we could also decode the JWT token
      const userId = (req.headers['user-id'] as string) || '';

      return { userId };
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
