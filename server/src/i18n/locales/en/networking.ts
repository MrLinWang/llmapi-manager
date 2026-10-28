import type { zhNetworking } from '../zh/networking';

/**
 * 设备互联的英文接口文案。
 *
 * 声明成 `typeof zhNetworking`：漏译或多键会直接编译失败。
 */
export const enNetworking: typeof zhNetworking = {
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
