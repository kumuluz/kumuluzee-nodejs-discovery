import { ConfigurationUtil } from 'kumuluzee-config';
import DiscoveryUtil from 'common/DiscoveryUtil';

class KumuluzeeDiscovery {
  async initialize({ extension }) {
    await DiscoveryUtil.initialize(extension);
  }

  async registerService(properties) {
    const serviceName = await ConfigurationUtil.get('kumuluzee.name') || (properties && properties.value) || null;

    if (!serviceName) console.error('Service name not provided!');

    const ttl = await ConfigurationUtil.get('kumuluzee.discovery.ttl') || (properties && properties.ttl) || 30;

    const pingInterval = await ConfigurationUtil.get('kumuluzee.discovery.ping-interval') || (properties && properties.pingInterval) || 20;

    const environment = await ConfigurationUtil.get('kumuluzee.env.name') || (properties && properties.environment) || 'dev';

    const version = await ConfigurationUtil.get('kumuluzee.version') || (properties && properties.version) || '1.0.0';

    const singleton = (properties && properties.singleton) || false;

    console.info(`Registering service: ${serviceName}`);

    DiscoveryUtil.register(serviceName, version, environment, ttl, pingInterval, singleton);
  }

  async deregisterService() {
    await DiscoveryUtil.deregister();
  }

  discoverService({ value, version = '*', environment = 'dev', accessType = 'GATEWAY' }) {
    return DiscoveryUtil.getServiceInstance(value, version, environment, accessType);
  }

  async disableServiceInstance({ value, version, environment, url }) {
    await DiscoveryUtil.disableServiceInstance(value, version, environment, url);
  }
}

export { DiscoveryUtil };
export default new KumuluzeeDiscovery();
