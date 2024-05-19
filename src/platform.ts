import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic, Categories } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import AGHGroup from './platformAccessory';
import AGH, { AdGuardStatus as AGHStatus, AdGuardStatus } from './adguardhome';

// TODO smolloy:
// locks/races?
// final logging check


/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class AdGuardHomePlus implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  private readonly switchGroups: AGHGroup[] = [];

  // AdGuard Home server connection
  private readonly host: string;
  private readonly port: string;
  private readonly https: boolean;
  private readonly username: string;
  private readonly password: string;
  private readonly interval: number;
  private readonly statusTimeout: number;

  // Misc
  private readonly name: string;
  private readonly noCache: boolean;
  private readonly clearUnusedCache: boolean;
  private readonly agh: AGH;
  private lastStatus: AdGuardStatus = new AdGuardStatus();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.name = this.config.name!;
    this.host = this.config['host'] || 'localhost';
    this.port = this.config['port'] || 80;
    this.https = !!this.config['https'];
    this.username = this.config['username'];
    this.password = this.config['password'];
    this.statusTimeout = this.config['statusTimeout'] || 7500;
    this.interval = this.config['interval'] || 10000;
    this.noCache = !(this.config['useCache'] || false); // !(false, unless explicity set to true)
    this.clearUnusedCache = (this.config['clearUnusedCache'] === false); // true, unless explicity set to false

    this.agh = new AGH(this.host, this.port, this.https, this.username, this.password, this.statusTimeout, this.log);

    this.log.debug('Finished initializing platform:', this.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      log.debug('Executing didFinishLaunching callback');
      // Get initial AGH status
      const initialStatus: AdGuardStatus = await this.agh.getCurrentStatus(true, true, true);
      // run the method to discover / register your devices as accessories
      this.discoverDevices(initialStatus!);
      // keep switch state in sync with the current AdGuardHome status
      this.pollAdGuardStatusLoop();
      // restore/finish any timers that were left unfinished when last shutdown
      this.restoreUnfinishedTimers();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices(initialStatus: AdGuardStatus) {

    if (!this.config['switches']) {
      return;
    }

    const configuredUUIDs: string[] = [];

    // Loop over configured switches and register each one if it has not already been registered
    for (const switchConfig of this.config['switches']) {
      // If the switch is unbridged, each timer needs it's own accessory
      const isBridged = !(switchConfig['bridged'] === false);
      const originalTimeouts: string = switchConfig['autoResetTimes'];
      let actualTimeouts: string[] = [originalTimeouts];
      if (!isBridged) {
        actualTimeouts = (switchConfig['autoResetTimes'] === undefined) ? ['0'] : switchConfig['autoResetTimes'].split(',');
      }

      actualTimeouts.forEach((timeouts) => {
        // generate a unique id for the accessory
        const timerVal = parseInt(timeouts);
        const accessoryName = (isBridged || (!isNaN(timerVal) && timerVal === 0))
          ? switchConfig.name : `${switchConfig.name}: ${timerVal} minute${timerVal > 1 ? 's' : ''}`;
        const uuid = this.api.hap.uuid.generate(accessoryName);
        configuredUUIDs.push(uuid);

        // see if a switch group with the same uuid has already been registered and restored from
        // the cached devices we stored in the `configureAccessory` method above
        const existingGroup = this.accessories.find(accessory => accessory.UUID === uuid);

        if (existingGroup && !this.noCache) {
          // the switch group already exists
          this.log.info('Restoring existing switch group from cache:', existingGroup.displayName);

          // update the accessory.context and run `api.updatePlatformAccessories`. eg.:
          existingGroup.context.config = switchConfig;
          this.api.updatePlatformAccessories([existingGroup]);

          // create the accessory handler for the restored accessory
          // this is imported from `platformAccessory.ts`
          this.switchGroups.push(new AGHGroup(this, existingGroup, initialStatus, this.agh));
        } else {
          // For debugging: remove the cached switch group and start from scratch
          // that way there won't be any artifacts attached to the group from previous
          // debug attempts that found their way into the accessory cache.
          if (this.noCache && existingGroup) {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingGroup]);
            this.log.info('Removing existing switch from cache:', existingGroup.displayName);
          }

          // the switch group does not yet exist, so we need to create it
          this.log.info('Adding new switch group:', switchConfig.name);

          // create a new platform accessory
          const newGroup = new this.api.platformAccessory(accessoryName, uuid, switchConfig['category'] || Categories.PROGRAMMABLE_SWITCH);
          switchConfig['autoResetTimes'] = timeouts;
          newGroup.context.config = switchConfig;
          this.switchGroups.push(new AGHGroup(this, newGroup, initialStatus, this.agh));

          // link the accessory to your platform - or not
          if (isBridged) {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [newGroup]);
          } else {
            this.api.publishExternalAccessories(PLUGIN_NAME, [newGroup]);
          }
        }
      });
    }

    // All our configured switches are created. Clear out the cache of any we didn't re-hydrate.
    if (this.clearUnusedCache) {
      this.accessories.forEach((accessory) => {
        if (!configuredUUIDs.find(uuid => uuid === accessory.UUID)) {
          this.log.info(`Removing unused accessory '${accessory.displayName}' from cache.`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      });
    }
  }

  private pollAdGuardStatusLoop() {
    this.log.info(`Starting AdGuard Home+ monitoring loop with interval ${this.interval}...`);

    setInterval(async () => {
      let [getStatus, getDefSvcs, getClients]: boolean[] = [false, false, false];
      this.switchGroups.forEach((ags) => {
        if (ags.isGlobal) {
          getStatus ||= !ags.isSelectServices;
          getDefSvcs ||= ags.isSelectServices;
        } else {
          getClients = true; // Needed in both client cases for @tag expansion.
        }
      });

      this.log.debug(`Checking AGH status [${getStatus}, ${getDefSvcs}, ${getClients}]...`);
      const currentStatus: AdGuardStatus = await this.agh.getCurrentStatus(getStatus, getDefSvcs, getClients);

      if (currentStatus.isAvailable === true && this.lastStatus.isAvailable !== true) {
        this.log.info('AdGuardHome Server is now responsive.');
      } else if (currentStatus.isAvailable !== true && this.lastStatus.isAvailable === true) {
        this.log.info('AdGuardHome Server is not responding:');
        if (currentStatus.error) {
          this.log.error(currentStatus.error);
        }
      }

      this.updateSwitchGroups(currentStatus)
        .catch((error) => {
          this.log.error('Failed to update switch states!');
          this.log.error(error.response ? error.response.body : error);
          currentStatus.isAvailable = false;
          this.updateSwitchGroups(currentStatus)
            .catch((e2) => {
              this.log.error('DOUBLE FAIL!! Switches still not updated! ');
              this.log.error(e2.response ? e2.response.body : e2);
            });
        });
      this.lastStatus = currentStatus;
    }, this.interval);
  }

  private async restoreUnfinishedTimers() {
    this.switchGroups.forEach(async (group) => {
      this.log.debug(`Restoring timers for '${group.name}'...`);
      await group.restoreUnfinishedTimers();
      this.log.debug(`  Done restoring timers for '${group.name}'`);
    });
  }

  private async updateSwitchGroups(currentStatus: AGHStatus) {
    this.switchGroups.forEach((group) => {
      this.log.debug(`Updating platform status for '${group.name}' (IsAvailable: ${currentStatus.isAvailable})...`);
      group.update(currentStatus);
      this.log.debug(`  Done updating platform status for '${group.name}' (IsAvailable: ${currentStatus.isAvailable}).`);
    });
  }
}
