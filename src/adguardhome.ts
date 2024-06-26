import got, { /* CancelableRequest, */ Response, Got } from 'got';
import { Logger } from 'homebridge';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdGuardClientConfig = any;
export class AdGuardStatus {
  public isAvailable: boolean | undefined;
  public error;
  public enabled: boolean | undefined;
  public blocked_services: string[] = [];
  public clients: AdGuardClientConfig[] = [];
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

  public async getCurrentStatus(getStatus: boolean, getDefaultServices: boolean, getClientServices: boolean)
    : Promise<AdGuardStatus> {
    const currentStatus = new AdGuardStatus;
    currentStatus.isAvailable = true;

    // eslint-disable-next-line max-len
    this.log.debug(`AGH: Querying AGHome server for current status: [${getStatus}, ${getDefaultServices}, ${getClientServices}]...`);
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

  public async postClients(enabled: boolean, clients: string[],
    readClientDataAsync: (key: string) => Promise<AdGuardClientConfig>,
    writeClientDataAsync: (key: string, data: AdGuardClientConfig) => Promise<void>) {
    this.log.info(`AGH: Setting Client status to: ${enabled} - [${clients.join(',')}]`);

    const clientList = this.expandTags(clients);
    const postList = clientList.map((cname) => this.latest.clients.find((c) => c.name === cname))
      .filter((cc) => !!cc)
      .map(async (clientConfig) => {
        let newClientConfig: AdGuardClientConfig;
        if (enabled) {
          // If re-enabling blocking, try to restore previous config. Fall back on 'enabling'
          // as best as we can with current config.
          newClientConfig = (await readClientDataAsync(clientConfig.name))
            ?? this.setBlockingConfig(clientConfig, true);
        } else {
          // If disabling blocking, save the current config and turn off everything.
          if (this.isBlockingEnabled(clientConfig)) { // Only save the config if it actually turns on blocking.
            await writeClientDataAsync(clientConfig.name, clientConfig);
          }
          newClientConfig = this.setBlockingConfig(clientConfig, false);
        }
        const newConfigPayload = { name: clientConfig.name, data: newClientConfig };
        this.log.debug(`AGH: creating a promise to post to 'clients/update' for client ${clientConfig.name}`);
        return this.aghApi.post('clients/update', {
          json: newConfigPayload,
          headers: { 'X-homebridge-aghp-info': `clients - ${enabled} [${clientConfig.name}]` },
        });
      });

    return this.doPostWrapper(Promise.allSettled(postList));
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
      });

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
          if (!newClientList.includes(exp.name)) {
            newClientList.push(exp.name);
          }
        });
      } else if (c.includes('*')) {
        this.latest.clients.filter((cstat) => this.wildcardMatch(c, cstat.name)).forEach((exp) => {
          if (!newClientList.includes(exp.name)) {
            newClientList.push(exp.name);
          }
        });
      } else {
        if (!newClientList.includes(c)) {
          newClientList.push(c);
        }
      }
    });

    return newClientList;
  }

  public isBlockingEnabled(clientStatus: AdGuardClientConfig, ignoreServices = false): boolean {
    // Shortcut if there is not status record
    if (!clientStatus) {
      return false;
    }

    // Clients are considered to have ad blocking enabled if any of these are enabled:
    //  1) filtering
    //  2) safe search
    //  3) parental filter
    //  4) safebrowsing filter
    //  5) any services blocked
    // All these need to be turned off to qualify as disabled.
    let isBlocking: boolean = (clientStatus.use_global_settings === true);
    isBlocking ||= !ignoreServices && (clientStatus?.use_global_blocked_services === true);
    isBlocking ||= !ignoreServices && (clientStatus?.blocked_services?.length > 0);
    isBlocking ||= (clientStatus.filtering_enabled === true);
    isBlocking ||= (clientStatus.parental_enabled === true);
    isBlocking ||= (clientStatus.safebrowsing_enabled === true);
    isBlocking ||= (clientStatus.safesearch_enabled === true);
    isBlocking ||= (clientStatus?.safe_search?.enabled === true);
    return isBlocking;
  }

  private setBlockingConfig(clientConfig: AdGuardClientConfig, blocking: boolean): AdGuardClientConfig {
    const newCfg: AdGuardClientConfig = JSON.parse(JSON.stringify(clientConfig));

    // The assumption here is that 'clientConfig' is boilerplate. If it was a previously saved
    // specific state, then we wouldn't be here trying to enable/disable it.
    if (blocking) {
      // Default to using global settings, unless we detect that 'clientConfig' already has
      // some block settings enabled.
      if (!this.isBlockingEnabled(clientConfig)) {
        this.log.info(`Turn on blocking for '${clientConfig.name}':`
          + 'No saved config & not already enabled - use global settings.');
        newCfg.use_global_settings = true;
        newCfg.use_global_blocked_services = true;
      } else {
        this.log.info(`Turn on blocking for '${clientConfig.name}':`
          + 'No saved config but already enabled - decide on global settings.');
        newCfg.use_global_settings = clientConfig.use_global_settings || !this.isBlockingEnabled(clientConfig, true);
        newCfg.use_global_blocked_services = (clientConfig?.blocked_services?.length > 0);
      }
    } else {
      // Unblocking - 'unset' everything.
      this.log.info(`Turn of blocking for '${clientConfig.name}'.`);
      newCfg.use_global_settings = false;
      newCfg.filtering_enabled = false;
      newCfg.parental_enabled = false;
      newCfg.safebrowsing_enabled = false;
      newCfg.safesearch_enabled = false;
      if (newCfg.safe_search) {
        newCfg.safe_search.enabled = false;
      }
      newCfg.use_global_blocked_services = false;
      newCfg.blocked_services = [];
    }

    return newCfg;
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

  private wildcardMatch(wildcard: string, str: string, caseSensitive = true) {
    const w = wildcard.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${w.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, caseSensitive ? '' : 'i');
    return re.test(str);
  }
}
