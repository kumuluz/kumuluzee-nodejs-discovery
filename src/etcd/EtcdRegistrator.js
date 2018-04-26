import { getServiceKeyInstances, getEtcdDir, getLastKeyLayer } from 'etcd/EtcdUtils';

class EtcdRegistrator {
  constructor(etcd, serviceConfig, resilience) {
    this.etcd = etcd;
    this.serviceConfig = serviceConfig;
    this.resilience = resilience;
    this.isRegistered = false;
  }

  run() {
    if (!this.isRegistered) {
      this.registerToEtcd();
    } else {
      this.sendHeartbeat();
    }
  }
  async registerToEtcd() {
    const isRegistered = await this.isServiceRegistered();
    let currentRetryDelay = this.serviceConfig.startRetryDelay;
    if (this.serviceConfig.singleton && !isRegistered) {
      console.error('Instance was not registered. Trying to register a singleton microservice instance, but ' +
                    'another instance is already registered.');
    } else if (this.etcd && !this.isRegistered) {
      console.info(`Registering service with etcd. Service ID: ${this.serviceConfig.serviceKeyUrl}`);
      const callback = (err, res) => {
        const register = () => {
          if (!this.isRegistered) this.etcd.mkdir(this.serviceConfig.serviceInstanceKey, { ttl: this.serviceConfig.ttl, maxRetries: 0 }, callback);
        };
        if (err || !res) {
          if (!this.resilience) {
            this.handleTimeoutException(err);
          }
          console.error(`Etcd exception: ${err}`);

          setTimeout(() => register(), currentRetryDelay);
          currentRetryDelay *= 2;
          if (currentRetryDelay > this.serviceConfig.maxRetryDelay) {
            currentRetryDelay = this.serviceConfig.maxRetryDelay;
          }
        } else {
          this.etcd.setSync(this.serviceConfig.serviceKeyUrl, this.serviceConfig.baseUrl);

          if (this.serviceConfig.containerUrl) {
            this.etcd.setSync(`${this.serviceConfig.serviceInstanceKey}/containerUrl`, this.serviceConfig.containerUrl);
          }
          if (this.serviceConfig.clusterId) {
            this.etcd.setSync(`${this.serviceConfig.serviceInstanceKey}/clusterId`, this.serviceConfig.clusterId);
          }
          this.isRegistered = true;
        }
      };

      this.etcd.mkdir(this.serviceConfig.serviceInstanceKey, { ttl: this.serviceConfig.ttl, maxRetries: 0 }, callback);
    }
  }

  async isServiceRegistered() {
    const serviceInstanceKey = getServiceKeyInstances(this.serviceConfig.environment, this.serviceConfig.serviceName, this.serviceConfig.version);

    const etcdKeysResponse = await getEtcdDir(this.etcd, serviceInstanceKey, -1, this.resilience, this.serviceConfig.startRetryDelay, this.serviceConfig.maxRetryDelay);

    const responseNodes = (etcdKeysResponse && etcdKeysResponse.body && etcdKeysResponse.body.node && etcdKeysResponse.body.node.nodes) || [];

    let url = null;
    let isActive = true;

    responseNodes.forEach(node => {
      if (getLastKeyLayer(node.key) === 'url' && node.value) url = node.value;
      if (getLastKeyLayer(node.key) === 'status' && node.value === 'disabled') isActive = false;
    });

    if (isActive && url) return true;

    return false;
  }

  sendHeartbeat() {
    console.info('Sending heartbeat.');
    let currentRetryDelay = this.serviceConfig.startRetryDelay;
    const callback = (err, res) => {
      const watch = () => {
        this.etcd.raw('PUT', `v2/keys${this.serviceConfig.serviceInstanceKey}`, null, { refresh: true, ttl: this.serviceConfig.ttl, dir: true, prevExist: true, maxRetries: 0 }, callback);
      };
      if (err || !res) {
        if (!this.resilience) {
          this.handleTimeoutException(err);
        }
        if (err.errorCode === 100) {
          console.error(`Etcd key not present: ${this.serviceConfig.serviceInstanceKey}. Registering service.`);
          this.isRegistered = false;
          this.registerToEtcd();
        } else {
          console.error(`Etcd exception: ${err}`);
        }

        setTimeout(() => watch(), currentRetryDelay);
        currentRetryDelay *= 2;
        if (currentRetryDelay > this.serviceConfig.maxRetryDelay) {
          currentRetryDelay = this.serviceConfig.maxRetryDelay;
        }
      }
    };

    this.etcd.raw('PUT', `v2/keys${this.serviceConfig.serviceInstanceKey}`, null, { refresh: true, ttl: this.serviceConfig.ttl, dir: true, prevExist: true, maxRetries: 0 }, callback);
  }

  handleTimeoutException(err) {
    const message = 'Timeout exception. Cannot read given key in specified time or retry-count constraints.';
    if (this.resilience) {
      console.error(`${message} ${err}`);
    } else {
      throw new Error(`${message} ${err}`);
    }
  }
}

export default EtcdRegistrator;
