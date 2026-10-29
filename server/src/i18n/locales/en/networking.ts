import type { zhNetworking } from '../zh/networking';

/**
 * 设备互联的英文接口文案。
 *
 * 声明成 `typeof zhNetworking`：漏译或多键会直接编译失败。
 */
export const enNetworking: typeof zhNetworking = {
  engine: {
    invalid: 'engine must be either builtin (in-house) or native (native module)',
  },
  listenPort: {
    invalid: 'listenPort must be an integer between 1 and 65535',
  },
  portForwards: {
    mustBeArray: 'portForwards must be an array',
    invalidVirtualPort: 'portForwards[].virtualPort must be an integer between 1 and 65535',
    invalidLocalPort: 'portForwards[].localPort must be an integer between 1 and 65535',
    duplicateVirtualPort: 'duplicate virtual port {{port}} in portForwards',
  },
  udpForwards: {
    mustBeArray: 'udpForwards must be an array',
    invalidVirtualPort: 'udpForwards[].virtualPort must be an integer between 1 and 65535',
    invalidTargetHost:
      'udpForwards[].targetHost must be a string (empty means auto-detect the system resolver)',
    invalidTargetPort: 'udpForwards[].targetPort must be an integer between 1 and 65535',
    duplicateVirtualPort: 'duplicate virtual port {{port}} in udpForwards',
  },
  enabled: {
    mustBeBoolean: 'enabled must be a boolean',
  },
  networkName: {
    required: 'networkName must not be empty',
  },
  networkSecret: {
    mustBeString: 'networkSecret must be a string',
  },
  peers: {
    mustBeStringArray: 'peers must be an array of strings',
  },
  hostname: {
    required: 'hostname must not be empty',
  },
  ipv4: {
    mustBeStringOrNull: 'ipv4 must be a string or null',
  },
  start: {
    needEnable: 'Enable device networking (enabled) in the config before starting',
  },
};
