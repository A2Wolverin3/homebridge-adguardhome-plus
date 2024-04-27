<table align="center"><tr><td>
<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" height="150"></td><td><img src="adguard_logo.png" height="90">
</td></tr></table>

# homebridge-adguardhome-plus

This is a dynamic platform plugin for Homebridge and can be used to create switches that track and control the state of an AdGuard Home server.

Inspired by the work of the [original AdGuard plugin](https://github.com/davidmerrique/homebridge-adguardhome) by @davidmerrique, this plugin takes things a few steps further by introducing a
new 'Television' switch type that is able to display more complex status on a single accessory tile -
similar to a 'Lock', but without being categorized as a security device that creates notifications
in everybody's HomeKit app.

It also allows turning ad-blocking off for specific clients or groups denoted with 'ctags.' Switches
can also be configured to un/block specific services instead of an all-or-nothing approach.

The plugin was developed based on the [Homebridge Plugin Template](https://github.com/homebridge/homebridge-plugin-template).

## Requirements

- [Homebridge](https://github.com/homebridge/homebridge) HomeKit support for the impatient
- [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome) Network-wide ads & trackers blocking DNS server

## Features
- Create accessories as 'Switch', 'Lock', or 'Television'
- Create accessories in a group
- Create bridged or unbridged accessories
- Control ad-blocking for the entire AdGuard Home server, or specific clients, or 'ctag' groups
- Control blocking of specific services defined by AdGuard Home

## Example config

```json
{
    "name": "AdGuard Home+",
    "host": "192.168.1.2",
    "https": false,
    "port": 8080,
    "username": "ADGUARD_USERNAME",
    "password": "ADGUARD_PASSWORD",
    "switches": [
        {
            "name": "AGH Global",
            "defaultState": true,
            "homekitType": "Switch",
            "bridged": true,
            "autoResetTimes": "60"
        },
        {
            "name": "AGH specific",
            "clients": "@user_child,my_homepod",
            "services": "amazon,ebay,tiktok",
            "defaultState": true,
            "homekitType": "Television",
            "forceState": true
        }
    ],
    "platform": "AdGuardHome-Plus"
}
```

### AdGuard Server Settings
| Option      | Default        | Explanation
|-------------|----------------|----------------
| 'name'      | - *Required* - | The name for the plugin.
| 'host'      | - *Required* - | IP or Hostname of the AdGuard Home server.
| 'https'     | HTTP (false)   | Use HTTP or HTTPS when connecting to the AdGuard Home server.
| 'port'      | 80             | The port number for the AdGuard Home server web interface.
| 'username'  | -              | The AdGuard Home login username.
| 'password'  | -              | The AdGuard Home login password.

### Switch Configuration
| Option           | Default        | Explanation
|------------------|----------------|----------------
| 'name'           | - *Required* - | The base name for the swtich that will appear in the Home app. (Timer-based switches will have timeouts appended to the name.)
| 'homekitType'    | Switch         | The type of accessory that will be created in the Home app. Can be one of ['Switch', 'Lock', 'Television']
| 'bridged'        | true           | Create the accessory on the default homebridge (true) or publish unbridged. Bridged accessories are easier to setup, but unbridged accessories have better icon control for Television. (Neither has great 'Category' control.) Also, unbridged accessories with multiple timers do not get grouped.
| 'clients'        | ''             | A comma-separated list of AdGuard clients or @tags this switch will apply to. (Leave empty to apply to global AdGuard Home settings.)
| 'services'       | ''             | A comma-separated list of service names AdGuard will filter for the configured clients when turned on. (Leave empty to enable/disable _all_ DNS filtering for configured clients.)
| 'autoResetTimes' | ''             | A comma-separated list of timeouts in minutes to wait before restoring the default state of the switch. (Set to '' or use 0 for no timer; Use multiple timers to create multiple switches within a single accessory group.)
| 'defaultState'   | true           | The 'natural' state of the switch. Use for restoring state when timers expire.
| 'forceState'     | false          | Force consistent filtering state in AdGuard Home, even if it's current state does not fully match the 'on' or 'off' criteria for this switch. (i.e. Only 2 of 3 configured services are currently being blocked.) Enabling this will result in losing that 'inconsistent' state when the switch is triggered.

Or, as @davidmerrique suggested with his AdGuard plugin - just use [Homebridge Config UI X](https://github.com/homebridge/homebridge-config-ui-x)

