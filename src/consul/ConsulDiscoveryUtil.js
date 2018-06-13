import consulClient from 'consul';
import { URL } from 'url';
import { ConfigurationUtil } from '@kumuluz/kumuluzee-config';
import InitializationUtils from 'common/InitializationUtils';
import ConsulServiceConfiguration from 'consul/ConsulServiceConfiguration';
import ConsulRegistrator from 'consul/ConsulRegistrator';
import CommonUtil from 'common/CommonUtil';
import { getConsulServiceKey, getInstanceFromServiceHealth } from 'consul/ConsulUtils';

class ConsulDiscoveryUtil {
  consul = null
  kvClient = null
  healthClient = null

  startRetryDelay = null
  maxRetryDelay = null

  CONSUL_WATCH_WAIT_SECONDS = 120

  registeredServices = []
  serviceInstances = new Map()
  serviceVersions = new Map()
  gatewayUrls = new Map()

  async init() {
    let consulAgentUrl = await ConfigurationUtil.get('kumuluzee.config.consul.agent') || 'http://localhost:8500';
    try {
      consulAgentUrl = new URL(consulAgentUrl);
    } catch (err) {
      console.error(`Malformed URL exception: ${err}`);
    }
    console.info(`Connectig to Consul Agent at: ${consulAgentUrl}`);

    // Get retry delays
    this.startRetryDelay = await InitializationUtils.getStartRetryDelayMs(ConfigurationUtil, 'consul');
    this.maxRetryDelay = await InitializationUtils.getMaxRetryDelayMs(ConfigurationUtil, 'consul');

    try {
      this.consul = consulClient({
        host: consulAgentUrl.hostname,
        port: consulAgentUrl.port,
        secure: (consulAgentUrl.protocol === ':https'),
        timeout: ((this.CONSUL_WATCH_WAIT_SECONDS * 1000) + ((this.CONSUL_WATCH_WAIT_SECONDS * 1000) / 16) + 1000),
        promisify: true,
      });
    } catch (err) {
      console.error(`Error when connecting to consul: ${err}`);
    }

    try {
      await this.consul.agent.self();
    } catch (err) {
      console.error(`Cannot ping Consul agent: ${err}`);
    }

    this.kvClient = this.consul.kv;
    this.healthClient = this.consul.health;
    this.agentClient = this.consul.agent;
  }

  async register(serviceName, version, environment, ttl, pingInterval, singleton) {
    const serviceProtocol = await ConfigurationUtil.get('kumuluzee.discovery.consul.protocol') || 'http';

    // Get service port
    const servicePort = await ConfigurationUtil.get('kumuluzee.server.http.port') || 8080;

    const deregisterCriticalServiceAfter = await ConfigurationUtil.get('kumuluzee.config.consul.deregister-critical-service-after-s') || 60;

    const serviceConfiguration = new ConsulServiceConfiguration(
      serviceName, environment, version, serviceProtocol, servicePort,
      ttl, singleton, this.startRetryDelay, this.maxRetryDelay,
      deregisterCriticalServiceAfter,
    );

    // Register and schedule heartbeats
    const registrator = new ConsulRegistrator(this.agentClient, this.healthClient, serviceConfiguration);

    registrator.run();
    setInterval(() => registrator.run(), pingInterval * 1000);

    this.registeredServices.push(serviceConfiguration);
  }

  async deregister() {
    if (this.agentClient) {
      const promises = this.registeredServices.map(service => {
        console.info(`Deregistering service with Consul. Service name: ${service.serviceName} Service ID: ${service.serviceId}`);
        return this.agentClient.service.deregister(service.serviceId);
      });
      try {
        await Promise.all(promises);
      } catch (err) {
        console.error(`Exception when deregistering service: ${err}`);
      }
    }
  }

  async getServiceInstances(serviceName, version, environment, accessType) {
    const consulServiceKey = getConsulServiceKey(serviceName, environment);

    if (!this.serviceInstances.get(consulServiceKey) || !this.serviceVersions.get(consulServiceKey)) {
      console.info('Performing service lookup on Consul Agent.');

      let serviceHealths = [];
      try {
        serviceHealths = await this.healthClient.service({
          service: consulServiceKey,
          passing: true,
        });
      } catch (err) {
        console.error(`Error retrieving healthy service instances from Consul: ${err}`);
      }
      const serviceVersions = [];
      const serviceUrls = [];

      serviceHealths.forEach(serviceHealth => {
        const consulService = getInstanceFromServiceHealth(serviceHealth);
        if (consulService) {
          serviceUrls.push(consulService);
          serviceVersions.push(consulService.version);
        }
      });

      this.serviceInstances.set(consulServiceKey, serviceUrls);
      this.serviceVersions.set(consulServiceKey, serviceVersions);
      this.addServiceListener(consulServiceKey);
    }

    const serviceList = this.serviceInstances.get(consulServiceKey);
    let urlList = [];

    if (version) {
      const resolvedVersion = await CommonUtil.determineVersion(this, serviceName, version, environment);

      urlList = serviceList.filter(service => service.version == resolvedVersion).map(service => service.serviceUrl);
      if (accessType === 'GATEWAY' && urlList.length > 0) {
        const gatewayUrl = await this.getGatewayUrl(serviceName, resolvedVersion, environment);
        if (gatewayUrl) {
          urlList = [gatewayUrl];
        }
      }
    }
    return urlList;
  }

  async getServiceInstance(serviceName, version, environment, accessType) {
    const optionalServiceInstances = await this.getServiceInstances(serviceName, version, environment, accessType);

    return CommonUtil.pickServiceInstanceRoundRobin(optionalServiceInstances) || null;
  }

  async getGatewayUrl(serviceName, version, environment) {
    let currentRetryDelay = this.startRetryDelay;

    if (!this.gatewayUrls.has(`${serviceName}_${version}_${environment}`)) {
      const fullKey = `environments/${environment}/services/${serviceName}/${version}/gatewayUrl`;
      let gatewayUrl = null;
      try {
        const res = await this.kvClient.get(fullKey);
        if (res) {
          gatewayUrl = new URL(res.Value);
        }
      } catch (err) {
        console.error(`Exception when getting gatewayUrl: ${err}`);
      }

      this.gatewayUrls.set(`${serviceName}_${version}_${environment}`);

      let index = 0;

      let waitTime = this.CONSUL_WATCH_WAIT_SECONDS / 60;
      waitTime = `${waitTime}m`;

      const callback = (err, res, data) => {
        const watch = async () => {
          if (!this.connected) {
            try {
              const info = await this.consul.agent.self();
              if (info.DebugConfig.DevMode) index = 0;
              this.connected = true;
            } catch (_) {
            }
          }

          try {
            this.kvClient.get({
              key: fullKey,
              wait: waitTime,
              index,
            }, callback);
          } catch (tryErr) {
            console.error(tryErr);
          }
        };

        if (err) {
          if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
            this.connected = false;
            setTimeout(() => watch(), currentRetryDelay);

            currentRetryDelay *= 2;
            if (currentRetryDelay > this.maxRetryDelay) {
              currentRetryDelay = this.maxRetryDelay;
            }
          } else {
            console.error(`Watch error: ${err}`);
            watch();
          }
        } else {
        // Response is succesful
          currentRetryDelay = this.startRetryDelay;

          const responseIndex = data.headers['x-consul-index'];
          if (res) {
            if (responseIndex !== index) {
              gatewayUrl = res.Value;
              if (gatewayUrl) {
                console.info(`Gateway URL at ${fullKey} changed. New value: ${gatewayUrl}`);
                try {
                  gatewayUrl = new URL(gatewayUrl);
                } catch (parseErr) {
                  console.error(`Malformed URL exception: ${parseErr}`);
                }

                this.gatewayUrls.set(`${serviceName}_${version}_${environment}`, gatewayUrl);
              }
            }
          } else if (this.gatewayUrls.get(`${serviceName}_${version}_${environment}`)) {
            console.info(`Gateway URL at ${fullKey} deleted.`);
            this.gatewayUrls.set(`${serviceName}_${version}_${environment}`, null);
          }
          index = responseIndex;

          watch();
        }
      };
      try {
        this.kvClient.get({
          key: fullKey,
          wait: waitTime,
          index,
        }, callback);
      } catch (err) {
        console.error(err);
      }
      return gatewayUrl;
    }

    return this.gatewayUrls.get(`${serviceName}_${version}_${environment}`);
  }

  addServiceListener(serviceKey) {
    let lengthOfServices = -1;
    let currentRetryDelay = this.startRetryDelay;

    const listen = () => {
      const listener = this.consul.watch({
        method: this.healthClient.service,
        options: {
          service: serviceKey,
        },
      });

      listener.on('change', (res) => {
        currentRetryDelay = this.startRetryDelay;

        if (lengthOfServices !== res.length) {
          console.info(`Service instances for service ${serviceKey} refreshed!`);
          this.serviceInstances.set(serviceKey, []);
          this.serviceVersions.set(serviceKey, []);

          res.forEach(service => {
            const consulService = getInstanceFromServiceHealth(service);
            if (consulService) {
              this.serviceInstances.get(serviceKey).push(consulService);
              this.serviceVersions.get(serviceKey).push(consulService.version);
            }
          });
          lengthOfServices = res.length;
        }
      });

      listener.on('error', (err) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
          listener.end();
          setTimeout(() => listen(), currentRetryDelay);

          currentRetryDelay *= 2;
          if (currentRetryDelay > this.maxRetryDelay) {
            currentRetryDelay = this.maxRetryDelay;
          }
        } else {
          console.error(`Consul error when listening for changes: ${err}`);
        }
      });
    };

    listen();
  }

  getServiceVersions(serviceName, environment) {
    const consulServiceKey = getConsulServiceKey(serviceName, environment);
    if (!this.serviceVersions.has(consulServiceKey)) {
      this.getServiceInstances(serviceName, null, environment, 'DIRECT');
    }

    return this.serviceVersions.get(consulServiceKey);
  }

  async disableServiceInstance(serviceName, version, environment, url) {
    await this.getServiceInstances(serviceName, version, environment, 'DIRECT');
    const serviceList = this.serviceInstances.get(getConsulServiceKey(serviceName, environment));
    serviceList.forEach(async consulService => {
      if (consulService.version === version && consulService.serviceUrl == url) {
        try {
          await this.agentClient.service.maintenance({ id: consulService.id, enable: true });
        } catch (err) {
          console.error(`Error deregistering service with Consul: ${err}`);
        }
      }
    });
  }
}

export default new ConsulDiscoveryUtil();
