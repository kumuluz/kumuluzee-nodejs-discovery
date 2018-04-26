import uuidv4 from 'uuid/v4';
import { getConsulServiceKey } from 'consul/ConsulUtils';

class ConsulServiceConfiguration {
    serviceName = null
    environment = null
    version = null
    serviceId = null
    serviceProtocol = null
    servicePort = null
    ttl = null
    singleton = false
    startRetryDelay = null
    maxRetryDelay = null
    deregisterCriticalServiceAfter = null

    constructor(serviceName, environment, version, serviceProtocol, servicePort, ttl, singleton, startRetryDelay, maxRetryDelay, deregisterCriticalServiceAfter) {
      this.serviceName = serviceName;
      this.environment = environment;
      this.version = version;
      this.serviceId = `${serviceName}-${uuidv4()}`;
      this.serviceProtocol = serviceProtocol;
      this.servicePort = servicePort;
      this.ttl = ttl;
      this.singleton = singleton;
      this.startRetryDelay = startRetryDelay;
      this.maxRetryDelay = maxRetryDelay;
      this.deregisterCriticalServiceAfter = deregisterCriticalServiceAfter;
    }

    getServiceConsulKey() {
      return getConsulServiceKey(this.serviceName, this.environment);
    }
}

export default ConsulServiceConfiguration;
