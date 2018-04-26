import { getInstanceFromServiceHealth } from 'consul/ConsulUtils';

class ConsulRegistrator {
  constructor(agentClient, healthClient, serviceConfiguration) {
    this.agentClient = agentClient;
    this.healthClient = healthClient;
    this.serviceConfiguration = serviceConfiguration;
    this.isRegistered = false;
    this.currentRetryDelay = serviceConfiguration.startRetryDelay;
  }

  run() {
    if (!this.isRegistered) {
      this.registerToConsul();
    } else {
      this.sendHeartbeat();
    }
  }

  async registerToConsul() {
    const isHealthy = await this.isServiceRegistered();
    if (this.serviceConfiguration.singleton && isHealthy) {
      console.info('Instance was not registered. Trying to register a singleton microservice instance, but another instance is already registered.');
    } else {
      console.info(`Registering service with Consul. Service name: ${this.serviceConfiguration.serviceName} Service ID: ${this.serviceConfiguration.serviceId}`);
      if (this.agentClient) {
        const register = async () => {
          try {
            const ttlCheck = {
              ttl: `${this.serviceConfiguration.ttl}s`,
              deregistercriticalserviceafter: `${this.serviceConfiguration.deregisterCriticalServiceAfter}s`,
            };
            await this.agentClient.service.register({
              port: this.serviceConfiguration.servicePort,
              name: this.serviceConfiguration.getServiceConsulKey(),
              id: this.serviceConfiguration.serviceId,
              check: ttlCheck,
              tags: [this.serviceConfiguration.serviceProtocol, `version=${this.serviceConfiguration.version}`],
            });

            this.isRegistered = true;
            this.currentRetryDelay = this.serviceConfiguration.startRetryDelay;

            this.sendHeartbeat();
          } catch (err) {
            console.error(`Consul Exception when registering service: ${err}`);
            setTimeout(() => register(), this.currentRetryDelay);

            // exponential increase, limited by maxRetryDelay
            this.currentRetryDelay *= 2;
            if (this.currentRetryDelay > this.serviceConfiguration.maxRetryDelay) {
              this.currentRetryDelay = this.serviceConfiguration.maxRetryDelay;
            }
          }
        };

        await register();
      } else {
        console.error('Consul not initialized.');
      }
    }
  }

  async isServiceRegistered() {
    if (this.healthClient) {
      let serviceInstances = [];

      try {
        serviceInstances = await this.healthClient.service({
          service: this.serviceConfiguration.getServiceConsulKey(),
          passing: true,
        });
      } catch (err) {
        console.error(`Error retrieving healthy instances from Consul. Cannot determine, if service is already registered. ConsulException: ${err}`);
        return true;
      }

      let registered = false;
      serviceInstances.forEach(serviceHealth => {
        const consulService = getInstanceFromServiceHealth(serviceHealth);
        if (consulService && consulService.version === this.serviceConfiguration.version) {
          registered = true;
        }
      });

      return registered;
    }

    console.info('Consul not initialized');
    return false;
  }

  async sendHeartbeat() {
    console.info('Sending heartbeat.');
    try {
      await this.agentClient.check.pass(`service:${this.serviceConfiguration.serviceId}`);
    } catch (err) {
      console.error('Received NotRegisteredException from Consul AgentClient when sending heartbeat. Reregistering service.');
      this.isRegistered = false;
      this.registerToConsul();
    }
  }
}

export default ConsulRegistrator;
