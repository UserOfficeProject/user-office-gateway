import 'reflect-metadata';
import {
  ApolloGateway,
  RemoteGraphQLDataSource,
  ServiceEndpointDefinition,
} from '@apollo/gateway';
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
  ];

  const gateway = new ApolloGateway({
    serviceList,

    buildService({ url, name }) {
      console.log('Registering service: `%s` (%s)', name, url);

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
    console.log(`Apollo Gateway ready at ${url}`);
  });
}

bootstrap().catch(e => {
  console.error(e);
  process.exit(1);
});
