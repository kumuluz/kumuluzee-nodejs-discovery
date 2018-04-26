import uuidv4 from 'uuid/v4';
import { getServiceKeyInstance } from 'etcd/EtcdUtils';

class EtcdServiceConfiguration {
    serviceName = null
    environment = null
    version = null
    serviceId = null
    ttl = null
    singleton = false
    baseUrl = null
    containerUrl = null
    clusterId = null
    startRetryDelay = null
    maxRetryDelay = null
    serviceInstanceKey = null
    serviceKeyUrl = null

    constructor(serviceName, environment, version, ttl, singleton, baseUrl, containerUrl, clusterId, startRetryDelay, maxRetryDelay) {
      this.serviceName = serviceName;
      this.environment = environment;
      this.version = version;
      this.serviceId = `${serviceName}-${uuidv4()}`;
      this.ttl = ttl;
      this.singleton = singleton;
      this.baseUrl = baseUrl;
      this.containerUrl = containerUrl;
      this.clusterId = clusterId;
      this.startRetryDelay = startRetryDelay;
      this.maxRetryDelay = maxRetryDelay;
      this.serviceInstanceKey = getServiceKeyInstance(this.environment, this.serviceName, this.version, this.serviceId);
      this.serviceKeyUrl = `${this.serviceInstanceKey}/url/`;
    }
}

export default EtcdServiceConfiguration;
