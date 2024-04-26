import got, { /* CancelableRequest, */ Response, Got } from 'got';
import { Logger } from 'homebridge';

export class AdGuardStatus {
  public isAvailable: boolean | undefined;
  public error;
  public enabled: boolean | undefined;
  public blocked_services: string[] = [];
  public blocked_clients: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public clients: any[] = [];
}

export default class AdGuardHomeServer {

  private readonly aghApi: Got;
  private readonly latest: AdGuardStatus = new AdGuardStatus();

  constructor(
    public readonly host: string,
    public readonly port: string,
    public readonly https: boolean,
    public readonly username: string,
    public readonly password: string,
    public readonly timeout: number,
    public readonly log: Logger,
  ) {
    const prefixUrl = `http${https ? 's' : ''}://${host}:${port}/control`;
    const Authorization = `Basic ${Buffer.from(
      `${username}:${password}`,
    ).toString('base64')}`;

    this.aghApi = got.extend({
      prefixUrl: prefixUrl,
      responseType: 'json',
      timeout: timeout,
      retry: {
        limit: 0,
      },
      headers: {
        Authorization,
      },
      https: {
        rejectUnauthorized: false,
      },
    });

    this.log.debug(`AdGuard Http client created: [${prefixUrl}]`);
  }

  public async getCurrentStatus(getStatus: boolean, getDefaultServices: boolean, getDisallowedClients: boolean, getClientServices: boolean)
    : Promise<AdGuardStatus> {
    const currentStatus = new AdGuardStatus;
    currentStatus.isAvailable = true;

    // eslint-disable-next-line max-len
    this.log.debug(`AGH: Querying AGHome server for current status: [${getStatus}, ${getDefaultServices}, ${getDisallowedClients}, ${getClientServices}]...`);
    let abortPromise = false;
    await Promise.all([
      getStatus ? this.aghApi('status')
        .json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((body: any) => {
          if (!abortPromise) {
            this.latest.enabled = currentStatus.enabled = body.protection_enabled;
          }
        })
        : Promise.resolve(),

      getDefaultServices ? this.aghApi('blocked_services/get')
        .json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((body: any) => {
          if (!abortPromise) {
            this.latest.blocked_services = currentStatus.blocked_services = body.ids;
          }
        })
        : Promise.resolve(),

      getDisallowedClients ? this.aghApi('access/list')
        .json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((body: any) => {
          if (!abortPromise) {
            this.latest.blocked_clients = currentStatus.blocked_clients = body.disallowed_clients;
          }
        })
        : Promise.resolve(),

      getClientServices ? this.aghApi('clients')
        .json()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((body: any) => {
          if (!abortPromise) {
            this.latest.clients = currentStatus.clients = body.clients;
          }
        })
        : Promise.resolve(),
    ])
      .catch((error) => {
        abortPromise = true;
        this.log.debug('AGH: AGHome server is unreachable!');
        currentStatus.isAvailable = false;
        currentStatus.error = (error.response) ? error.response.body : error;
      })
      .then(() => {
        this.log.debug('AGH: All requested statuses have been received.');
        return currentStatus;
      });

    return currentStatus;
  }

  public async postGlobal(enabled: boolean): Promise<boolean> {
    this.log.info(`AGH: Setting Global status to: ${enabled}`);

    return this.doPostWrapper(
      this.aghApi.post('dns_config', {
        json: { protection_enabled: enabled },
        headers: { 'X-homebridge-aghp-info': `global - ${enabled}` },
      }),
    );
  }

  public async postGlobalServices(enabled: boolean, services: string[]): Promise<boolean> {
    this.log.info(`AGH: Setting Global Services status to: ${enabled} - [${services.join(',')}]`);

    const newServiceList = enabled ? this.merge(this.latest.blocked_services, services)
      : this.remove(this.latest.blocked_services, services);
    return this.doPostWrapper(
      this.aghApi.put('blocked_services/update', {
        json: { ids: newServiceList },
        headers: { 'X-homebridge-aghp-info': `global-services - ${enabled} [${services.join(',')}]` },
      }),
    );
  }

  public async postClients(enabled: boolean, clients: string[]): Promise<boolean> {
    this.log.info(`AGH: Setting Client status to: ${enabled} - [${clients.join(',')}]`);

    const clientList = this.expandTags(clients);
    const newClientList = enabled ? this.merge(this.latest.blocked_clients, clientList)
      : this.remove(this.latest.blocked_clients, clientList);
    return this.doPostWrapper(
      this.aghApi.post('access/set', {
        json: { disallowed_clients: newClientList },
        headers: { 'X-homebridge-aghp-info': `client - ${enabled} [${clients.join(',')}]` },
      }),
    );
  }

  public async postClientServices(enabled: boolean, clients: string[], services: string[]): Promise<boolean> {
    this.log.info(`AGH: ${enabled ? 'Blocking' : 'Unblocking'} Client Services for: ${clients.join(',')}`);
    this.log.info(`     Services: [${services.join(',')}]`);

    const clientList = this.expandTags(clients);
    const postList = clientList.map((cname) => this.latest.clients.find((c) => c.name === cname))
      .filter((cc) => !!cc)
      .map(async (clientConfig) => {
        const newServiceList = enabled ?
          this.merge(clientConfig.blocked_services, services)
          : this.remove(clientConfig.blocked_services, services);
        const newData = JSON.parse(JSON.stringify(clientConfig));
        newData.blocked_services = newServiceList;
        const newConfig = { name: clientConfig.name, data: newData };
        this.log.debug(`AGH: creating a promise to post to 'clients/update' for client ${clientConfig.name}`);
        return this.aghApi.post('clients/update', {
          json: newConfig,
          headers: { 'X-homebridge-aghp-info': `client-services - ${enabled} [${clientConfig.name}]` },
        });
      },
      );

    return this.doPostWrapper(Promise.allSettled(postList));
  }

  private async doPostWrapper(post: Promise<Response<string>>
    | Promise<PromiseSettledResult<Response<string>>[]>): Promise<boolean> {
    // Should type-check the array items with '.every'... but  we know we're only going to get an array
    // here from Promise.allSettled(). Single promises return http response objects, not arrays.
    const success: boolean = await post.then((result) => {
      // Check that all promises succeeded
      if (Array.isArray(result)) {
        //const isFulfilled = <T,>(p:PromiseSettledResult<T>): p is PromiseFulfilledResult<T> => p.status === 'fulfilled';
        const isRejected = <T, >(p:PromiseSettledResult<T>): p is PromiseRejectedResult => p.status === 'rejected';

        const failed = result.filter(isRejected);
        if (failed.length > 0) {
          const failedResponses = failed.map(p => p.reason); // Get actual results out of PromiseSettledResult<T>
          failedResponses.forEach((r) => {
            // I don't know what the shape of 'reason' is. Let's just see what it says.
            this.log.warn('AGH: Promise.allSettled request failed.');
            this.log.error(r);
          });
          return false;
        }

        this.log.debug('AGH: Returning true after finding no errors in Promise.allSettled.');
        return true;
      }

      // Otherwise, we can simply check the status code
      if (result.statusCode === 200) {
        return true;
      }

      this.log.info(`AGH: Request returned non-200 status code: ${result.statusCode}`);
      if (result.request) {
        this.log.debug(`AGH: Headers == ${result.request.headers}`);
      }
      this.log.error(result.response ? result.response.body : result);
      return false;
    })
      .catch((error) => {
        this.log.info(`AGH: Request failed with an error: ${error.code}`);
        if (error.request) {
          this.log.debug(`AGH: Headers == ${error.request.headers}`);
        }
        this.log.error(error.response ? error.response.body : error);
        return false;
      });

    return success;
  }

  public expandTags(clientList: string[]): string[] {
    const newClientList: string[] = [];

    if (!this.latest.clients) {
      return newClientList;
    }

    clientList.forEach((c) => {
      if (c.startsWith('@')) {
        this.latest.clients.filter((cstat) => cstat.tags.includes(c.substring(1))).forEach((exp) => {
          newClientList.push(exp.name);
        });
      } else {
        newClientList.push(c);
      }
    });

    return newClientList;
  }

  private merge(list1: string[], list2: string[], sort = false): string[] {
    const newList: string[] = [];
    list1.forEach((s) => newList.push(s));
    list2.forEach((s) => {
      if (!newList.includes(s)) {
        newList.push(s);
      }
    });

    if (sort) {
      newList.sort((a, b) => (a > b ? 1 : -1));
    }

    return newList;
  }

  private remove(oldList: string[], subList: string[]): string[] {
    const newList: string[] = [];
    oldList.forEach((s) => {
      if (!subList.includes(s)) {
        newList.push(s);
      }
    });
    return newList;
  }
}
