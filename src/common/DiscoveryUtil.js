import ConsulDiscoveryUtil from 'consul/ConsulDiscoveryUtil';
import EtcdDiscoveryUtil from 'etcd/EtcdDiscoveryUtil';

class DiscoveryUtil {
  discoverySource = null;

  async initialize(extension) {
    if (extension === 'consul') {
      this.discoverySource = ConsulDiscoveryUtil;
    } else if (extension === 'etcd') {
      this.discoverySource = EtcdDiscoveryUtil;
    } else {
      console.error('Invalid extension');
    }

    await this.discoverySource.init();
  }

  async register(serviceName, version, environment, ttl, pingInterval, singleton) {
    this.discoverySource.register(serviceName, version, environment, ttl, pingInterval, singleton);

    // Application was interupted (Console)
    process.on('SIGINT', async () => {
      await this.deregister();
      process.exit();
    });

    // Application got signal to terminate (ex: Kubernetes)
    process.on('SIGTERM', async () => {
      await this.deregister();
      process.exit();
    });
  }

  async deregister() {
    await this.discoverySource.deregister();
  }

  getServiceInstance(serviceName, version, environment, accessType) {
    return this.discoverySource.getServiceInstance(serviceName, version, environment, accessType);
  }

  getServiceInstances(serviceName, version, environment, accessType) {
    return this.discoverySource.getServiceInstances(serviceName, version, environment, accessType);
  }

  disableServiceInstance(serviceName, version, environment, url) {
    this.discoverySource.disableServiceInstance(serviceName, version, environment, url);
  }
}

export default new DiscoveryUtil();
