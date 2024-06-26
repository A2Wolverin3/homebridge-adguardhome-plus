import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { AdGuardHomePlus } from './platform';
import AGH, { AdGuardStatus as AGHStatus, AdGuardClientConfig } from './adguardhome';
import ServiceManager, { ServiceType } from './serviceManager';
import fs_sync, {promises as fs} from 'fs';

export const enum AdGuardHomeState {
  BLOCKING = 'Blocking',
  DISABLED = 'Disabled',
  INCONSISTENT = 'Inconsistent',
  UNAVAILABLE = 'Unavailable',
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 *
 * This is a grouping accessory that offers an array of switch services.
 * This allows for some degree of organization within HomeKit.
 */
export default class AdGuardHomeServiceGroup {
  public get name(): string {
    return this.groupName;
  }

  public get isGlobal(): boolean {
    return (this.clients.length === 0);
  }

  public get isSelectServices(): boolean {
    return (this.services.length > 0);
  }

  public get currentState(): AdGuardHomeState {
    return this._currentState;
  }

  private set currentState(value: AdGuardHomeState) {
    if (this.isValidState(value)) {
      this.targetState = value;
      this._currentState = value;
    }
  }

  public get targetState(): AdGuardHomeState {
    return this._targetState;
  }

  private set targetState(value: AdGuardHomeState) {
    if (this.isConsistentState(value)) {
      this._targetState = value;
    }
  }

  public readonly serviceType: string;

  // Accessory Config
  private readonly groupName: string;
  private readonly defaultState: boolean;
  private readonly forceState: boolean;
  private readonly storageRoot: string;
  private readonly timerFile: string;
  private readonly clientStorageRoot: string;
  private readonly isBridged: boolean;
  private readonly clients: string[];
  private readonly services: string[];
  private readonly switches: Service[] = [];
  private readonly accessoryInfo: Service;
  private readonly serviceManager: ServiceManager;
  private readonly log: Logger;

  private _currentStatus: AGHStatus;
  private _currentState: AdGuardHomeState;
  private _targetState: AdGuardHomeState;
  private _currentTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly platform: AdGuardHomePlus,
    private readonly accessory: PlatformAccessory,
    private readonly initialStatus: AGHStatus,
    private readonly agh: AGH,
  ) {
    const config = accessory.context.config;
    this.groupName = config['name'];
    this.defaultState = !(config['defaultState'] === false); // true, unless explicitly false
    this.forceState = (config['forceState'] === true);
    this.serviceType = config['homekitType'] || ServiceType.Switch;
    this.storageRoot = this.platform.api.user.storagePath() + '/agh_plus/' + this.groupName.replace(/([^a-zA-Z0-9]+)/g, '_');
    this.timerFile = `${this.storageRoot}/timer`;
    this.clientStorageRoot = this.platform.api.user.storagePath() + '/agh_plus/clients';  // Share client 'on' state across entire platform
    this.isBridged = !(config['bridged'] === false);
    this.log = platform.log;

    this.log.info(`Initializing AdGuard Home Switch Group ${this.groupName}...`);

    // set accessory information
    this.accessoryInfo = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    this.accessoryInfo.setCharacteristic(this.platform.Characteristic.Manufacturer, config['manufacturer'] || 'AdGuard Home')
      .setCharacteristic(this.platform.Characteristic.Model, config['model'] || 'AdGuard Home')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, config['serial-number'] || '123-456-789')
      .setCharacteristic(this.platform.Characteristic.Name, this.groupName)
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, this.groupName);

    // Make sure client and service list are consistent.
    this.clients = (config['clients'] === undefined) ? [] : config['clients'].split(',').map((c) => c.trim());
    this.services = (config['services'] === undefined) ? [] : config['services'].split(',').map((s) => s.trim());

    // Parse initial state
    this._currentStatus = this.initialStatus;
    this._targetState = this.toAGHState(this.defaultState);
    this._currentState = AdGuardHomeState.UNAVAILABLE;
    const initState = this.currentState = this.getStateFromAdGuardStatus(this.initialStatus);

    // Ensure the state directory exists
    try {
      fs_sync.mkdirSync(this.storageRoot, { recursive: true });
      fs_sync.mkdirSync(this.clientStorageRoot, { recursive: true });
    } catch (err) {
      this.log.warn(`Error creating state directory for '${this.groupName}'!`, err);
    }

    // Create a switch for each timeout given in config, or create a single non-timed switch.
    // If unbridged, only create the first.
    this.serviceManager = new ServiceManager(this, this.platform.api, this.log);
    const timeoutValues = new Set<string>((config['autoResetTimes'] === undefined) ? ['0'] : config['autoResetTimes'].split(','));
    for (const timeoutString of timeoutValues) {
      const timeout: number = parseInt(timeoutString);

      if (isNaN(timeout) || timeout < 0) {
        const msg = `Unknown or invalid timeout value '${timeout}' given for accessory '${this.groupName}'.`;
        this.log.error(msg);
        throw new Error(msg);
      }

      const service = this.serviceManager.createService(accessory, timeout, initState, /* concise: */ (timeoutValues.size > 1));
      this.serviceManager.addEventHandlers(service, timeout);
      this.switches.push(service);

      // platform.ts should already ensure we only have 1 timeout value for unbridged accessories. But just in case...
      if (!this.isBridged) {
        break;
      }
    }

    this.updateHomeKit(this.currentState);

    this.log.info(`AdGuard Home Switch Group ${this.groupName} initialized to ${initState}.`);
  }

  public async restoreUnfinishedTimers() {
    return this.readTimerStorage().then((timeout) => {
      // If the timeout is invalid or doesn't exist, reset the file and do nothing.
      if (!timeout || isNaN(timeout)) {
        return this.writeTimerStorage(0);
      } // eslint-disable-line brace-style

      // If the timeout is 0, then there is no timer to restore.
      else if (timeout === 0) {
        return Promise.resolve();
      }

      const now = new Date().getTime();

      // If a non-zero timeout is in the past, then a timer expired without resetting AGH.
      if (now >= timeout) {
        this.log.info(`Cleaning up expired timer for '${this.groupName}'.`);
        return this.writeTimerStorage(0).then(() => {
          this.setAdGuardState(this.defaultState).then((agState) => {
            this.updateHomeKit(agState, this.toAGHState(this.defaultState));
          });
        });
      }

      // If the timeout is in the future, then restart the timer.
      const diff = Math.ceil((timeout - now) / (60 * 1000)); // ms => min
      this.log.info(`Restarting timer for '${this.groupName}' to expire in ${diff} minutes.`);
      return this.startNewTimer(diff);
    });
  }

  public update(currentStatus: AGHStatus) {
    this._currentStatus = currentStatus;
    const newState = this.getStateFromAdGuardStatus(currentStatus);
    if (newState !== this.currentState) {
      this.updateHomeKit(newState, newState);
    }
  }

  public async handleHomeKitSetEvent(service: Service, value: CharacteristicValue, timeout: number) {
    // Don't force updates unless allowed
    if (!this.isConsistentState(this.currentState) && !this.forceState) {
      // eslint-disable-next-line max-len
      this.log.info(`Abort handleHomeKitSetEvent due to inconsistent state: ${service.displayName}: (${this.currentState}, ${this.forceState})`);
      setTimeout(() => {
        this.updateHomeKit(this.currentState);
      });
      return;
    }

    // If switching to non-default state on a timer switch... start the timer.
    // If switching back to the default state... cancel any timers.
    const newAGHState = !!value;
    if (newAGHState !== this.defaultState) {
      await this.startNewTimer(timeout);
    } else {
      await this.startNewTimer(0);
    }

    // Now change AdGuard state
    return this.setAdGuardState(newAGHState).then(() => {
      // This doesn't take effect unless we've exited the 'onSet' handler. Use setTimeout().
      setTimeout(() => {
        this.updateHomeKit(this.currentState);
      });
    });
  }

  private async setAdGuardState(agState: boolean): Promise<AdGuardHomeState> {
    // This is where we should post to AGH. The HTTP side of it should exist in the AGH class... but the knowledge of
    // which AGH API to POST to and what data to send to it reside in here. :/
    const target = this.targetState = this.toAGHState(agState);
    this.log.info(`Setting current state for AdGuard Home Switch Group '${this.groupName}' initialized to (${target})`);
    let successful = false;
    if (this.isGlobal) {
      if (this.isSelectServices) {
        successful = await this.agh.postGlobalServices(agState, this.services);
      } else {
        successful = await this.agh.postGlobal(agState);
      }
    } else {
      if (this.isSelectServices) {
        successful = await this.agh.postClientServices(agState, this.clients, this.services);
      } else {
        // Clients requires special handling. If turning blocking off, we need to store the options/services that
        // are currently specified for each client so we can restore the same state when re-enabling blocking.
        successful = await this.agh.postClients(agState, this.clients,
          /* readClientDataAsync: */ (cname) => this.readClientState(cname),
          /* writeClientDataAsync: */ (cname, data) => this.writeClientState(cname, data));
      }
    }

    if (!successful) {
      this.log.warn(`Unable to change AdGuard Home status. Setting internal state to ${AdGuardHomeState.UNAVAILABLE}.`);
    }
    this.currentState = successful ? target : AdGuardHomeState.UNAVAILABLE;

    return this.currentState;
  }

  private updateHomeKit(state: AdGuardHomeState, target: AdGuardHomeState = this.targetState ) {
    this.targetState = target;
    this.switches.forEach((service) => {
      this.serviceManager.updateHomeKit(service, state, target);
    });
    this.currentState = state;
  }

  private getStateFromAdGuardStatus(status: AGHStatus): AdGuardHomeState {
    if (status.isAvailable !== true) {
      return AdGuardHomeState.UNAVAILABLE;
    }

    // Check the status report and see if our little corner is enabled or disabled
    // -1: none, 0: some, 1: all
    let cmp = 0;
    if (this.isGlobal) {
      if (this.isSelectServices) {
        cmp = this.containsAllOrNone(status.blocked_services, this.services);
      } else {
        cmp = status.enabled ? 1 : -1;
      }
    } else {
      const clientList = this.agh.expandTags(this.clients);
      let all = true;
      let none = true;
      this.log.debug(`getStateFromAdGuardStatus: Checking client list: [${clientList.join(',')}]`);
      if (this.isSelectServices) {
        clientList.forEach((client) => {
          const clientStatus = status.clients.find((c) => c.name === client);
          if (clientStatus !== undefined) {
            const ccomp = this.containsAllOrNone(clientStatus.blocked_services, this.services);
            this.log.debug(`    Client[${client}] service check: ${ccomp}`);
            all &&= (ccomp > 0);
            none &&= (ccomp < 0);
          } else {
            this.log.debug(`    Client[${client}] service check: not found`);
            all = false;
          }
        });
      } else {
        // Clients with no service list: any of 1) filtering enabled, 2) safe search enabled, or 3) services blocked
        // means blocking is enabled. All three need to be turned off to qualify as disabled. Like the 'global' switch
        // without services, there is no 'inconsistent' state for any one client. However, multiple clients can be on
        // or off, which would be inconsistent as a group - so use the same boolean accumulation used with client services.
        clientList.forEach((client) => {
          const clientStatus = status.clients.find((c) => c.name === client);
          if (clientStatus !== undefined) {
            const blocking = this.agh.isBlockingEnabled(clientStatus);
            this.log.debug(`    Client[${client}] blocking check: ${blocking}`);
            all &&= blocking;
            none &&= !blocking;
          } else {
            this.log.debug(`    Client[${client}] blocking check: not found`);
            all = false;
          }
        });
      }
      cmp = (all ? 1 : (none ? -1 : 0));
    }

    if (cmp < 0) {
      return AdGuardHomeState.DISABLED;
    } else if (cmp > 0) {
      return AdGuardHomeState.BLOCKING;
    }

    return AdGuardHomeState.INCONSISTENT;
  }

  private async startNewTimer(minutes: number) {
    // Sanitize timeout
    const timeout = minutes < 0 ? 0 : minutes > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : minutes;

    // Clear the old timer if it exists
    if (this._currentTimer) {
      this.log.info(`Clearing existing timers for '${this.groupName}'.`);
      clearTimeout(this._currentTimer);
    }

    // If no timeout, then clear the timer file and do nothing else.
    if (timeout === 0) {
      this.log.debug(`Clearing any existing timers for '${this.groupName}'.`);
      return this.writeTimerStorage(0);
    }

    const newTimeout = new Date().getTime() + (timeout * 60 * 1000);
    this.log.info(`Starting new timer for '${this.groupName}': ${timeout} minutes`);
    return this.writeTimerStorage(newTimeout).then(() => {
      this._currentTimer = setTimeout(async () => {
        this.log.info(`Timer expired: Restoring '${this.groupName}' to its default state - ${this.defaultState}.`);
        this.writeTimerStorage(0).then(() => {
          this.setAdGuardState(this.defaultState).then((agState) => {
            this.updateHomeKit(agState, this.toAGHState(this.defaultState));
          });
        });
      }, timeout * 60 * 1000);  // minutes => ms
    });
  }

  private async readTimerStorage(): Promise<number | undefined> {
    return fs.readFile(this.timerFile, 'utf8')
      .then((s) => parseInt(s))
      .catch((err) => {
        this.log.debug('Failed to read timer file:', err);
        return undefined;
      });
  }

  private async writeTimerStorage(timer: number): Promise<void> {
    return fs.writeFile(this.timerFile, timer.toString(), 'utf8')
      .catch((err) => {
        this.log.warn('Failed to write timer file:', err);
      });
  }

  private async readClientState(name: string, clearStorage = true): Promise<AdGuardClientConfig> {
    if (!name) {  // name is null/empty/undefined
      return null;
    }

    this.log.debug(`Reading saved client[${name}] state...`);
    return fs.readFile(`${this.clientStorageRoot}/${name}`, 'utf8')
      .then((s) => JSON.parse(s))
      .then((state) => {
        if (clearStorage) {
          fs.unlink(`${this.clientStorageRoot}/${name}`);
        }
        return state;
      })
      .catch((err) => {
        this.log.warn(`Failed while reading saved client[${name}] state:`, err);
        return null;
      });
  }

  private async writeClientState(name: string, data: AdGuardClientConfig): Promise<void> {
    this.log.debug(`Saving client[${name}] state...`);
    return fs.writeFile(`${this.clientStorageRoot}/${name}`, JSON.stringify(data), 'utf8')
      .catch((err) => {
        this.log.warn(`Failed while writing saved client[${name}] state:`, err);
      });
  }

  private isConsistentState(state: string): boolean {
    switch(state) {
      case AdGuardHomeState.BLOCKING:
      case AdGuardHomeState.DISABLED:
        return true;
    }
    return false;
  }

  private isValidState(state: string): boolean {
    switch(state) {
      case AdGuardHomeState.BLOCKING:
      case AdGuardHomeState.DISABLED:
      case AdGuardHomeState.INCONSISTENT:
      case AdGuardHomeState.UNAVAILABLE:
        return true;
    }
    return false;
  }

  private toAGHState(bState: boolean): AdGuardHomeState {
    return bState ? AdGuardHomeState.BLOCKING : AdGuardHomeState.DISABLED;
  }

  private containsAllOrNone(superset: string[], subset: string[]): number {
    let all = true;
    let none = true;

    subset.forEach((s) => {
      if (superset.includes(s)) {
        none = false;
      } else {
        all = false;
      }
    });
    return (all ? 1 : (none ? -1 : 0));
  }
}
