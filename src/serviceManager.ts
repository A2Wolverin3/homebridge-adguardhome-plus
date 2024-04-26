// eslint-disable-next-line max-len
import { API, Service, PlatformAccessory, CharacteristicValue, Logger, HapStatusError, HAPStatus, Characteristic, Nullable } from 'homebridge';
import AGHGroup, { AdGuardHomeState as AGHState } from './platformAccessory';


// 'const enum' is faster, but requires manual lookups. See ctor.
export const enum ServiceType {
  Switch = 'Switch',
  Lock = 'Lock',
  TV = 'Television',
}

/**
 * Service Manager
 * This class abstracts away the details of which type of service is being used to represent
 * the adguard switch/status display. The platform/accessory can just focus on syncing status
 * with AGH and leave the details of switch representation to this class.
 */
export default class ServiceManager {
  private readonly Service: typeof Service = this.api.hap.Service;
  private readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  private readonly serviceType: string;

  constructor(
    private readonly group: AGHGroup,
    private readonly api: API,
    private readonly log: Logger,
  ) {
    this.serviceType = group.serviceType;

    // Have to do a manual string check, since 'const enum' optimizes away the lookup object.
    // Make that tradeoff for performance though, since this only happens during construction.
    switch (this.serviceType) {
      case ServiceType.Switch:
      case ServiceType.Lock:
      case ServiceType.TV:
        break;
      default:
        this.log.error(`SM: Requested switch type '${this.serviceType}' for group '${group.name}' is not valid!`);
        throw new this.api.hap.HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
  }

  public createService(accessory: PlatformAccessory, timeout: number, initState: string, concise: boolean): Service {
    // timeout is defined as a valid number by all callers
    const timerString: string = (timeout === 0) ? 'No Timer' : `${timeout} Minute${timeout > 1 ? 's' : ''}`;
    const configuredName = `${this.group.name} - ${timerString}`;
    const displayName: string = concise ? timerString : `${this.group.name}${(timeout === 0) ? '' : ': ' + timerString}`;
    const subtype: string = (timeout === 0) ? 'main_lock' : `timed_lock_${timeout}`;

    this.log.info(`SM: Creating AGHome Accessory:Service ${accessory.displayName}:${configuredName}[${subtype}](${this.serviceType}).`);

    if (this.serviceType === ServiceType.Lock) {
      const lockService = accessory.getService(configuredName) ||
        accessory.addService(this.Service.LockMechanism, configuredName, subtype);
      lockService.setCharacteristic(this.Characteristic.Name, displayName);
      lockService.name = displayName;
      this.mainCharacteristic(lockService)?.updateValue(this.toCharacteristicValue(initState));
      return lockService;

    } else if (this.serviceType === ServiceType.TV) {
      // Category-wise... just leaving this here:
      // https://nrchkb.github.io/wiki/service/television/#icons
      const tvService = accessory.getService(configuredName) ||
        accessory.addService(this.Service.Television, configuredName, subtype);
      tvService.setCharacteristic(this.Characteristic.SleepDiscoveryMode, this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
      tvService.setCharacteristic(this.Characteristic.Active, this.Characteristic.Active.ACTIVE); // Always On
      tvService.setCharacteristic(this.Characteristic.ActiveIdentifier, 1);
      tvService.setCharacteristic(this.Characteristic.Name, displayName);
      tvService.setCharacteristic(this.Characteristic.ConfiguredName, displayName);
      tvService.name = displayName;
      let inputName = `🟢${AGHState.BLOCKING}`;
      const inputBlocking = accessory.getService(inputName) ||
        accessory.addService(this.Service.InputSource, inputName, AGHState.BLOCKING);
      inputBlocking.setCharacteristic(this.Characteristic.Identifier, 1)
        .setCharacteristic(this.Characteristic.ConfiguredName, inputName)
        // NOT_CONFIGURED == not selectable in HK 👍
        .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.NOT_CONFIGURED)
        .setCharacteristic(this.Characteristic.InputSourceType, this.Characteristic.InputSourceType.HOME_SCREEN);
      inputName = `⚫${AGHState.DISABLED}`;
      const inputDisabled = accessory.getService(inputName) ||
        accessory.addService(this.Service.InputSource, inputName, AGHState.DISABLED);
      inputDisabled.setCharacteristic(this.Characteristic.Identifier, 2)
        .setCharacteristic(this.Characteristic.ConfiguredName, inputName)
        // NOT_CONFIGURED == not selectable in HK 👍
        .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.NOT_CONFIGURED)
        .setCharacteristic(this.Characteristic.InputSourceType, this.Characteristic.InputSourceType.HOME_SCREEN);
      inputName = `🟡${AGHState.INCONSISTENT}`;
      const inputInconsistent = accessory.getService(inputName) ||
        accessory.addService(this.Service.InputSource, inputName, AGHState.INCONSISTENT);
      inputInconsistent.setCharacteristic(this.Characteristic.Identifier, 3)
        .setCharacteristic(this.Characteristic.ConfiguredName, inputName)
        // NOT_CONFIGURED == not selectable in HK 👍
        .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.NOT_CONFIGURED)
        .setCharacteristic(this.Characteristic.InputSourceType, this.Characteristic.InputSourceType.HOME_SCREEN);
      inputName = `🔴${AGHState.UNAVAILABLE}`;
      const inputUnavailable = accessory.getService(inputName) ||
        accessory.addService(this.Service.InputSource, inputName, AGHState.UNAVAILABLE);
      inputUnavailable.setCharacteristic(this.Characteristic.Identifier, 4)
        .setCharacteristic(this.Characteristic.ConfiguredName, inputName)
        // NOT_CONFIGURED == not selectable in HK 👍
        .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.NOT_CONFIGURED)
        .setCharacteristic(this.Characteristic.InputSourceType, this.Characteristic.InputSourceType.OTHER);
      tvService.addLinkedService(inputBlocking);
      tvService.addLinkedService(inputDisabled);
      tvService.addLinkedService(inputInconsistent);
      tvService.addLinkedService(inputUnavailable);
      this.mainCharacteristic(tvService)?.updateValue(this.toCharacteristicValue(initState));
      return tvService;
    }

    // else if (this.serviceType === ServiceType.Switch) {
    const switchService = accessory.getService(configuredName) ||
      accessory.addService(this.Service.Switch, configuredName, subtype);
    switchService.setCharacteristic(this.Characteristic.Name, displayName);
    // ConfiguredName for switch: "not in required or optional characteristic section for service Switch. Adding anyway."
    // Good thing homebrige adds it anyway, because switches grouped in an accessory group end up with the group
    // name without this.
    switchService.setCharacteristic(this.Characteristic.ConfiguredName, displayName);
    switchService.name = displayName;
    this.mainCharacteristic(switchService)?.updateValue(this.toCharacteristicValue(initState));
    return switchService;
  }

  public addEventHandlers(service: Service, timeout: number) {
    this.log.info(`SM: Adding event handlers to Service ${service.displayName}.`);

    // TV requires special handling to control inputs an remain "always on"
    if (this.serviceType === ServiceType.TV) {
      // Use clicks on the main 'power' button to change state...
      // ... but that state is reflected elsewhere. Let this always appear 'On.'
      // (Unless AGH is unavailable of course.)
      service.getCharacteristic(this.Characteristic.Active)
        .onGet(async () => {
          if (this.group.currentState === AGHState.UNAVAILABLE) {
            throw this.createUnresponsiveError(service);
          }
          return this.Characteristic.Active.ACTIVE;
        })
        .onSet(async (/* value: CharacteristicValue */) => {
          // Can't actually rely on the incoming value since this characteristic is always 'on.'
          // Just toggle the current intended state. And then make sure the HomeKit tile stays on.
          this.group.handleHomeKitSetEvent(service, this.group.targetState !== AGHState.BLOCKING, timeout);
          setTimeout(() => {
            service.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.ACTIVE);
          });
        });

      // Use 'Input' to show more nuanced status. And prevent users from changing it manually.
      service.getCharacteristic(this.Characteristic.ActiveIdentifier)
        .onGet(async () => this.toCharacteristicValue(this.group.currentState))
        .onSet(async (/* value: CharacteristicValue */) => {
          setTimeout(() => service.updateCharacteristic(this.Characteristic.ActiveIdentifier,
            this.toCharacteristicValue(this.group.currentState)));
        });
    }

    // Anything other than main/target will need to be special-cased above.
    const main = this.mainCharacteristic(service);
    const target = this.targetCharacteristic(service);

    main?.onGet(async () => this.toCharacteristicValue(this.group.currentState, true));
    target?.onGet(async () => this.toCharacteristicValue(this.group.targetState));
    (target ? target : main)?.onSet(async (value: CharacteristicValue) => this.group.handleHomeKitSetEvent(service, value, timeout));
  }

  public updateHomeKit(service: Service, state: string, target: string) {
    this.log.debug(`SM: Calling updateHomeKit(${service.displayName}:${service.subtype}, ${state}, ${target})...`);

    this.mainCharacteristic(service)?.updateValue(this.toCharacteristicValue(state));
    this.targetCharacteristic(service)?.updateValue(this.toCharacteristicValue(target));

    // Services can show 'No Response' when they are unavailable. HOWEVER, setting them to that state
    // does not reflect immediately in HomeKit. (And conversely, does not resolve immediately in HomeKit
    // when they come back online.) This is slightly annoying, but 'No Response' is a good tool for
    // the UNAVAILABLE situation, so lets use it. (But still try to set a more immediate status with
    // the code above before overriding it with this delayed-but-more-appropriate status update.)
    if (state === AGHState.UNAVAILABLE) {
      const err: Nullable<CharacteristicValue> | HapStatusError | Error = this.createUnresponsiveError(service);
      this.log.debug(err.message);
      this.mainCharacteristic(service)?.updateValue(err);
    }

    this.log.debug(`   ...done with updateHomeKit(${service.displayName}:${service.subtype}, ${state}, ${target}).`);
  }

  private mainCharacteristic(service: Service): Characteristic | undefined {
    switch (this.serviceType) {
      case ServiceType.Lock:
        return service.getCharacteristic(this.Characteristic.LockCurrentState);
      case ServiceType.TV:
        return service.getCharacteristic(this.Characteristic.ActiveIdentifier);
      case ServiceType.Switch:
        return service.getCharacteristic(this.Characteristic.On);
    }

    return undefined;
  }

  private targetCharacteristic(service: Service): Characteristic | undefined {
    switch (this.serviceType) {
      case ServiceType.Lock:
        return service.getCharacteristic(this.Characteristic.LockTargetState);
    }

    return undefined;
  }

  public toCharacteristicValue(state: string, throwIfUnavailable = false): CharacteristicValue {
    if (throwIfUnavailable && state === AGHState.UNAVAILABLE) {
      throw this.createUnresponsiveError();
    }

    switch (this.serviceType) {
      case ServiceType.Lock:
        switch(state) {
          case AGHState.BLOCKING:
            return this.Characteristic.LockCurrentState.SECURED;
          case AGHState.DISABLED:
            return this.Characteristic.LockCurrentState.UNSECURED;
          case AGHState.INCONSISTENT:
            return this.Characteristic.LockCurrentState.JAMMED;
          case AGHState.UNAVAILABLE:
          default:
            return this.Characteristic.LockCurrentState.UNKNOWN;
        }

      case ServiceType.TV:
        switch(state) {
          case AGHState.BLOCKING:
            return 1;
          case AGHState.DISABLED:
            return 2;
          case AGHState.INCONSISTENT:
            return 3;
          case AGHState.UNAVAILABLE:
          default:
            return 4;
        }

      case ServiceType.Switch:
      default:
        return (state === AGHState.BLOCKING);
    }
  }

  private createUnresponsiveError(service: Service | undefined = undefined): HapStatusError {
    const err: HapStatusError = new this.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    err.message = `SM: Service '${this.group.name}:${service?.displayName}': AdGuardHome is unresponsive.`;
    return err;
  }
}
