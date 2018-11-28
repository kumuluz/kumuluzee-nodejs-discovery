import EtcdClient from 'node-etcd';
import os from 'os';
import { URL } from 'url';
import { ConfigurationUtil } from '@kumuluz/kumuluzee-config';
import InitializationUtils from 'common/InitializationUtils';
import EtcdServiceConfiguration from 'etcd/EtcdServiceConfiguration';
import EtcdRegistrator from 'etcd/EtcdRegistrator';
import CommonUtil from 'common/CommonUtil';

import { getEtcdDir, getLastKeyLayer, getServiceKeyInstances } from 'etcd/EtcdUtils';

class EtcdDiscoveryUtil {
  registeredServices = []
  registratorHandles = []

  serviceInstances = new Map()
  serviceVersions = new Map()
  gatewayUrls = new Map()

  lastKnownServices = new Map()
  lastKnownVersions = new Map()

  etcd = null
  initialRequestRetryPolicy = null
  startRetryDelay = null;
  maxRetryDelay = null;

  clusterId = ''

  resilience = false

  async init() {
    const etcdUsername = await ConfigurationUtil.get('kumuluzee.discovery.etcd.username') || null;
    const etcdPassword = await ConfigurationUtil.get('kumuluzee.discovery.etcd.password') || null;

    let cert = await ConfigurationUtil.get('kumuluzee.discovery.etcd.ca') || null;

    let sslContext = null;
    if (cert) {
      cert = cert.replace(/\s+/g, '').replace('-----BEGINCERTIFICATE-----', '').replace('-----ENDCERTIFICATE-----', '');
      sslContext = Buffer.from(cert, 'base64');
    }

    let etcdSecurityContext = null;

    if (etcdUsername && etcdUsername !== '' && etcdPassword && etcdPassword !== '') {
      etcdSecurityContext = {
        auth: {
          user: etcdUsername,
          pass: etcdPassword,
        },
      };
      if (sslContext) etcdSecurityContext.ca = sslContext;
    }
    const etcdUrls = await ConfigurationUtil.get('kumuluzee.discovery.etcd.hosts') || null;

    if (etcdUrls && etcdUrls !== '') {
      const splitedEtcdUrls = etcdUrls.split(',');

      const etcdHosts = splitedEtcdUrls;

      if (etcdHosts.length % 2 === 0) {
        console.error('Using an odd number of etcd hosts is recommended. See etcd documentation.');
      }

      if (etcdSecurityContext) {
        this.etcd = new EtcdClient(etcdHosts, etcdSecurityContext);
      } else {
        this.etcd = new EtcdClient(etcdHosts);
      }

      this.resilience = await ConfigurationUtil.get('kumuluzee.discovery.resilience');

      if (this.resilience === null) {
        this.resilience = true;
      }

      this.startRetryDelay = await InitializationUtils.getStartRetryDelayMs(ConfigurationUtil, 'etcd');
      this.maxRetryDelay = await InitializationUtils.getMaxRetryDelayMs(ConfigurationUtil, 'etcd');

      const initialRetryCount = await ConfigurationUtil.get('kumuluzee.discovery.etcd.initial-retry-count') || 1;

      if (initialRetryCount < 0) {
        this.initialRequestRetryPolicy = -1;
      } else {
        this.initialRequestRetryPolicy = initialRetryCount;
      }

      if (!this.resilience) {
        this.initialRequestRetryPolicy = 0;
      }
    } else {
      console.error('No etcd server hosts provided. Specify hosts with configuration key ' +
        'kumuluzee.discovery.etcd.hosts in format ' +
        'http://192.168.99.100:2379,http://192.168.99.101:2379,http://192.168.99.102:2379');
    }
    this.clusterId = await ConfigurationUtil.get('kumuluzee.discovery.cluster') || null;
  }

  async register(serviceName, version, environment, ttl, pingInterval, singleton) {
    let baseUrl = await ConfigurationUtil.get('kumuluzee.server.base-url') || null;
    if (baseUrl && baseUrl !== '') {
      try {
        baseUrl = new URL(baseUrl);
        baseUrl = baseUrl.toString();
      } catch (err) {
        console.error(`Cannot parse kumuluzee.server.base-url. Exception: ${err}`);
        baseUrl = null;
      }
    }

    let containerUrl = await ConfigurationUtil.get('kumuluzee.container-url') || null;

    if (containerUrl) {
      try {
        containerUrl = new URL(containerUrl);
        containerUrl = containerUrl.toString();
      } catch (err) {
        console.error(`Cannot parse kumuluzee.container-url. Exception:  ${err}`);
        baseUrl = null;
      }
    }

    if (this.clusterId || !baseUrl || baseUrl === '') {
      // Try to find my ip adress
      const networkInterfaces = os.networkInterfaces();
      let interfaceAddresses = [];

      Object.keys(networkInterfaces).forEach(key => {
        const addresses = networkInterfaces[key].filter(ia => !ia.internal);
        interfaceAddresses = interfaceAddresses.concat(addresses);
      });

      const servicePort = await ConfigurationUtil.get('kumuluzee.server.http.port') || 8080;
      let ipUrl = null;

      for (let i = 0; i < interfaceAddresses.length && !ipUrl; i++) {
        const inetAddress = interfaceAddresses[i];
        try {
          if (inetAddress.family === 'IPv4') {
            ipUrl = new URL(`http://${inetAddress.address}:${servicePort}`);
          } else {
            ipUrl = new URL(`http://[${inetAddress.address}]:${servicePort}`);
          }
          ipUrl = ipUrl.toString();
        } catch (err) {
          console.error(`Cannot parse URL. Exception: ${err}`);
        }
      }

      if (this.clusterId) {
        if (!containerUrl && ipUrl) {
          containerUrl = ipUrl;
        } else if (containerUrl == null) {
          console.error('No container URL found, but running in container. All services will use service ' +
                  'URL. You can set container URL with configuration key kumuluzee.container-url');
        }
      }

      if (!baseUrl || baseUrl !== '') {
        if (ipUrl) {
          console.error(`No service URL provided, using URL ${ipUrl}` +
                      '. You should probably set service URL with configuration key kumuluzee.server.base-url');
          baseUrl = ipUrl;
        } else {
          console.error('No service URL provided or found. Set service URL with configuration key kumuluzee.server.base-url');
          return;
        }
      }
    }

    const serviceConfiguration = new EtcdServiceConfiguration(serviceName, environment, version, ttl, singleton, baseUrl, containerUrl, this.clusterId, this.startRetryDelay, this.maxRetryDelay);

    this.registeredServices.push(serviceConfiguration);

    const registrator = new EtcdRegistrator(this.etcd, serviceConfiguration, this.resilience);

    registrator.run();
    const handle = setInterval(() => registrator.run(), pingInterval * 1000);

    this.registratorHandles.push(handle);
  }

  async deregister() {
    if (this.etcd) {
      this.registeredServices.forEach(serviceConfiguration => {
        console.info(`Deregistering service with etcd. Service name: ${serviceConfiguration.serviceName} Service ID: ${serviceConfiguration.serviceKeyUrl}`);
        try {
          const response = this.etcd.delSync(serviceConfiguration.serviceKeyUrl, { maxRetries: 1 });

          if (response.err) {
            // console.error(`Cannot deregister service. Error: ${response.err}`);
          }
        } catch (err) {
          console.error(`Exception when trying to deregister service. Error: ${err}`);
        }
      });
      this.registratorHandles.forEach(handle => {
        clearInterval(handle);
      });
    }
  }

  async getServiceInstances(serviceName, version, environment, accessType) {
    version = await CommonUtil.determineVersion(this, serviceName, version, environment);
    if (!this.serviceInstances.has(`${serviceName}_${version}_${environment}`)) {
      const etcdKeysResponseWhole = await getEtcdDir(this.etcd, getServiceKeyInstances(environment, serviceName, version), this.initialRequestRetryPolicy, this.resilience, this.startRetryDelay, this.maxRetryDelay);
      const etcdKeysResponse = etcdKeysResponseWhole.body;

      const serviceUrls = new Map();
      if (etcdKeysResponse) {
        if (etcdKeysResponse.node.nodes) {
          etcdKeysResponse.node.nodes.forEach(node => {
            let url = null;
            let containerUrlString = null;
            let clusterId = null;
            let isActive = true;

            if (node.nodes) {
              node.nodes.forEach(instanceNode => {
                const lastKeyLayer = getLastKeyLayer(instanceNode.key);
                const { value } = instanceNode;

                if (lastKeyLayer === 'url' && value) url = value;
                if (lastKeyLayer === 'containerUrl' && value) containerUrlString = value;
                if (lastKeyLayer === 'clusterId' && value && value !== '') clusterId = value;
                if (lastKeyLayer === 'status' && value === 'disabled') isActive = false;
              });
            }

            if (isActive && url) {
              try {
                const containerUrl = (!containerUrlString || containerUrlString === '') ? null : new URL(containerUrlString);
                serviceUrls.set(`${node.key}/url`, {
                  baseUrl: new URL(url),
                  containerUrl,
                  clusterId,
                });
              } catch (err) {
                console.error(`Malformed URL exception: ${err}`);
              }
            }
          });
        }

        this.serviceInstances.set(`${serviceName}_${version}_${environment}`, serviceUrls);

        if (!this.serviceVersions.has(`${serviceName}_${environment}`)) {
          // we are already watching all versions, no need to watch specific version
          this.watchServiceInstances(getServiceKeyInstances(environment, serviceName, version), parseInt(etcdKeysResponseWhole.data['x-etcd-index'], 10) + 1);
        }
      }
    }
    let presentServices = this.serviceInstances.get(`${serviceName}_${version}_${environment}`);
    if ((!presentServices || presentServices.size === 0) && this.lastKnownServices.has(`${serviceName}_${version}_${environment}`)) {
      // if no services are present, use the last known service
      console.error(`No instances of ${serviceName} found, using last known service.`);
      presentServices = new Map([[0, this.lastKnownServices.get(`${serviceName}_${version}_${environment}`)]]);
    }

    const instances = [];
    if (presentServices && presentServices.size > 0) {
      const gatewayUrl = await this.getGatewayUrl(serviceName, version, environment);
      if (accessType === 'GATEWAY' && gatewayUrl) {
        instances.push(gatewayUrl);
      } else {
        presentServices.forEach(service => {
          if (this.clusterId && this.clusterId === service.clusterId) {
            instances.push(service.containerUrl);
          } else {
            instances.push(service.baseUrl);
          }
        });
      }
    }

    return instances;
  }

  async getServiceInstance(serviceName, version, environment, accessType) {
    const optionalServiceInstances = await this.getServiceInstances(serviceName, version, environment, accessType);

    return CommonUtil.pickServiceInstanceRoundRobin(optionalServiceInstances) || null;
  }

  async getGatewayUrl(serviceName, version, environment) {
    let retryCounter = 0;
    let currentRetryDelay = this.startRetryDelay;

    return new Promise ((resolve) => {
      if (!this.gatewayUrls.has(`${serviceName}_${version}_${environment}`)) {
        this.gatewayUrls.set(`${serviceName}_${version}_${environment}`, null);
        let gatewayUrl = null;
        // let index = 0;

        const callback = (err, res, data) => {
          const get = () => {
            this.etcd.get(this.getGatewayKey(environment, serviceName, version), { maxRetries: 0 }, callback);
          };

          if (err) {
            if (err.errorCode === 100) {
              return resolve(null);
            }
            if (retryCounter >= this.initialRequestRetryPolicy && this.initialRequestRetryPolicy !== -1) {
              const message = 'Timeout exception. Cannot read given key in specified time or retry-count constraints.';
              if (this.resilience) {
                console.error(`${message} ${err}`);
              } else {
                throw new Error(`${message} ${err}`);
              }
              return resolve(null);
            }
            retryCounter += 1;

            setTimeout(() => get(), currentRetryDelay);
            currentRetryDelay *= 2;
            if (currentRetryDelay > this.maxRetryDelay) {
              currentRetryDelay = this.maxRetryDelay;
            }
          } else {
            try {
              index = etcdKeysResponse.body.node.modifiedIndex;
              gatewayUrl = new URL(etcdKeysResponse.body.node.value);
              this.gatewayUrls.set(`${serviceName}_${version}_${environment}`, gatewayUrl);
              // this.watchServiceInstances(this.getGatewayKey(environment,serviceName, version), index);

              resolve(gatewayUrl);
            } catch (urlErr) {
              console.error(`Malformed URL exception: ${urlErr}`);
            }
          }
        };

        this.etcd.get(this.getGatewayKey(environment, serviceName, version), { maxRetries: 0 }, callback);
      } else {
        resolve(this.gatewayUrls.get(`${serviceName}_${version}_${environment}`));
      }
    });
  }

  async getServiceVersions(serviceName, environment) {
    if (!this.serviceVersions.has(`${serviceName}_${environment}`)) {
      const etcdKeysResponseWhole = await getEtcdDir(this.etcd, this.getServiceKeyVersions(serviceName, environment), this.initialRequestRetryPolicy, this.resilience, this.startRetryDelay, this.maxRetryDelay);

      const versions = [];
      const etcdKeysResponse = etcdKeysResponseWhole && etcdKeysResponseWhole.body;
      if (etcdKeysResponse) {
        for (let i = 0; i < etcdKeysResponse.node.nodes.length; i++) {
          const versionNode = etcdKeysResponse.node.nodes[i];
          const version = getLastKeyLayer(versionNode.key);

          let instanceParentNode = versionNode.nodes.filter(candidate => (getLastKeyLayer(candidate.key) === 'instances'));

          if (instanceParentNode.length === 0 || !instanceParentNode[0].nodes) continue;

          [instanceParentNode] = instanceParentNode;
          let versionActive = false;

          instanceParentNode.nodes.forEach(instanceNode => {
            let url = null;
            let status = null;
            let containerUrlString = null;
            let clusterId = null;
            if (instanceNode.nodes) {
              instanceNode.nodes.forEach(node => {
                const lastKeyLayer = getLastKeyLayer(node.key);
                const { value } = node;

                if (lastKeyLayer === 'url' && value) url = value;
                if (lastKeyLayer === 'containerUrl' && value) containerUrlString = value;
                if (lastKeyLayer === 'clusterId' && value && value !== '') clusterId = value;
                if (lastKeyLayer === 'status' && value && value !== '') status = value;
              });
            }
            if (url && status !== 'disabled') {
              try {
                versionActive = true;
                if (!this.serviceInstances.has(`${serviceName}_${version}_${environment}`)) {
                  this.serviceInstances.set(`${serviceName}_${version}_${environment}`, new Map());
                }

                const containerUrl = (containerUrlString && containerUrlString !== '') ? new URL(containerUrlString) : null;

                const newUrl = new URL(url);

                this.serviceInstances.get(`${serviceName}_${version}_${environment}`).set(`${instanceNode.key}/url`, { baseUrl: newUrl, containerUrl, clusterId });
              } catch (err) {
                console.warn(`Malformed URL exception: ${err}`);
              }
            }
          });

          if (versionActive) {
            versions.push(version);
          }
        }

        this.serviceVersions.set(`${serviceName}_${environment}`, versions);
        this.watchServiceInstances(this.getServiceKeyVersions(serviceName, environment), parseInt(etcdKeysResponseWhole.data['x-etcd-index'], 10) + 1);
      }
    }

    let presentVersions = this.serviceVersions.get(`${serviceName}_${environment}`);

    const lastKnownVersion = this.lastKnownVersions.get(`${serviceName}_${environment}`);

    if (lastKnownVersion && (!presentVersions || !presentVersions.includes(lastKnownVersion))) {
      // if present versions does not contain version of last known service, add it to the return object (copy)
      presentVersions = presentVersions.concat(lastKnownVersion);
    }

    return presentVersions;
  }

  watchServiceInstances(key, index) {
    console.info(`Initialising watch for key: ${key}`);
    let currentRetryDelay = this.startRetryDelay;
    let errorIndex = 0;
    const callback = (err, res, data) => {
      const watch = (modifiedIndex) => {
        this.etcd.watch(key, { recursive: true, waitIndex: modifiedIndex + 1, maxRetries: 0 }, callback);
      };
      if (err || !res) {
        // Data with index is only given on first watch error.
        if (data) {
          errorIndex = parseInt(data['x-etcd-index']);
        }
        if (err) {
          console.error(`Exception when waiting for changes: ${err}`);
        }

        setTimeout(() => watch(errorIndex), currentRetryDelay);
        currentRetryDelay *= 2;
        if (currentRetryDelay > this.maxRetryDelay) {
          currentRetryDelay = this.maxRetryDelay;
        }
      } else {
        currentRetryDelay = this.startRetryDelay;

        const { node } = res;

        const nodeKey = node.key;
        const { value } = node;

        const serviceName = this.getServiceNameFromKey(nodeKey);
        const version = this.getVersionFromKey(nodeKey);
        const environment = this.getEnvironmentFromKey(nodeKey);

        if (serviceName && version && environment) {
          const lastKeyLayer = getLastKeyLayer(nodeKey);
          if (lastKeyLayer === 'url') {
            if (!value) {
              console.info(`Service instance deleted: ${nodeKey}`);
              if (this.serviceInstances.get(`${serviceName}_${version}_${environment}`).size === 1) {
                // if removing last service, save it to separate buffer
                // this service will be returned, if no other services are present
                this.lastKnownServices.set(`${serviceName}_${version}_${environment}`, this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(nodeKey));
                this.lastKnownVersions.set(`${serviceName}_${environment}`, version);
              }

              this.serviceInstances.get(`${serviceName}_${version}_${environment}`).delete(nodeKey);
            } else {
              console.info(`Service instance added: ${nodeKey} Value: ${value}`);
              try {
                if (!this.serviceInstances.has(`${serviceName}_${version}_${environment}`)) {
                  this.serviceInstances.set(`${serviceName}_${version}_${environment}`, new Map());
                }

                const etcd2Service = {
                  baseUrl: new URL(value),
                  containerUrl: null,
                  clusterId: null,
                };

                if (this.serviceInstances.get(`${serviceName}_${version}_${environment}`).has(nodeKey)) {
                  etcd2Service.containerUrl = this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(nodeKey).containerUrl;
                  etcd2Service.containerUrl = this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(nodeKey).clusterId;
                }
                this.serviceInstances.get(`${serviceName}_${version}_${environment}`).set(nodeKey, etcd2Service);
              } catch (urlErr) {
                log.severe(`Malformed URL exception: ${urlErr}`);
              }
            }
          }

          if (lastKeyLayer === 'containerUrl') {
            if (!value) {
              const service = this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(`${this.getKeyOneLayerUp(nodeKey)}url`);
              if (service) {
                console.info(`Service container url deleted: ${nodeKey}`);
                service.containerUrl = null;
                this.serviceInstances.get(`${serviceName}_${version}_${environment}`).set(`${this.getKeyOneLayerUp(nodeKey)}url`, service);
              }
            } else {
              console.info(`Service container url added: ${nodeKey} Value: ${value}`);
              try {
                if (!this.serviceInstances.has(`${serviceName}_${version}_${environment}`)) {
                  this.serviceInstances.set(`${serviceName}_${version}_${environment}`, new Map());
                }
                const instanceMapKey = `${this.getKeyOneLayerUp(nodeKey)}url`;
                const etcd2Service = {
                  baseUrl: null,
                  containerUrl: new URL(value),
                  clusterId: null,
                };

                if (this.serviceInstances.get(`${serviceName}_${version}_${environment}`).has(instanceMapKey)) {
                  etcd2Service.baseUrl = this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(instanceMapKey).baseUrl;
                  etcd2Service.clusterId = this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(instanceMapKey).clusterId;
                }

                this.serviceInstances.get(`${serviceName}_${version}_${environment}`).set(instanceMapKey, etcd2Service);
              } catch (urlErr) {
                console.error(`Malformed URL exception: ${urlErr}`);
              }
            }
          }

          if (lastKeyLayer === 'clusterId') {
            if (!value) {
              const service = this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(`${this.getKeyOneLayerUp(nodeKey)}url`);
              if (service) {
                console.info(`Service container id deleted ${nodeKey}`);
                service.clusterId = null;
                this.serviceInstances.get(`${serviceName}_${version}_${environment}`).set(`${this.getKeyOneLayerUp(nodeKey)}url`, service);
              }
            } else {
              console.info(`Service container id added ${nodeKey} Value: ${value}`);

              if (!this.serviceInstances.has(`${serviceName}_${version}_${environment}`)) {
                this.serviceInstances.set(`${serviceName}_${version}_${environment}`, new Map());
              }
              const instanceMapKey = `${this.getKeyOneLayerUp(nodeKey)}url`;
              const etcd2Service = {
                baseUrl: null,
                containerUrl: null,
                clusterId: new URL(value),
              };

              if (this.serviceInstances.get(`${serviceName}_${version}_${environment}`).has(instanceMapKey)) {
                etcd2Service.baseUrl = this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(instanceMapKey).baseUrl;
                etcd2Service.containerUrl = this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(instanceMapKey).clusterId;
              }
              this.serviceInstances.get(`${serviceName}_${version}_${environment}`).set(instanceMapKey, etcd2Service);
            }
          }

          if (lastKeyLayer === 'gatewayUrl') {
            if (!value && this.gatewayUrls.has(`${serviceName}_${version}_${environment}`)) {
              console.info(`Gateway URL deleted: ${nodeKey}`);
              this.gatewayUrls.delete(`${serviceName}_${version}_${environment}`);
            } else {
              console.info(`Gateway URL added or modified: ${nodeKey} Value: ${value}`);

              let gatewayUrl = null;

              try {
                gatewayUrl = new URL(value);
              } catch (urlErr) {
                console.error(`Malformed URL exception: ${urlErr}`);
              }

              this.gatewayUrls.set(`${serviceName}_${version}_${environment}`, gatewayUrl);
            }
          }

          if (lastKeyLayer === 'status' && value === 'disabled') {
            console.info(`Service instance disabled: ${nodeKey}`);
            this.serviceInstances.get(`${serviceName}_${version}_${environment}`).delete(`${this.getKeyOneLayerUp(nodeKey)}url`);
          }
          // Node's TTL expired
          if (res.action === 'expire' && this.serviceInstances.has(`${serviceName}_${version}_${environment}`) && this.serviceInstances.get(`${serviceName}_${version}_${environment}`).has(`${nodeKey}/url`)) {
            console.info(`Service instance TTL expired: ${nodeKey}`);
            if (this.serviceInstances.get(`${serviceName}_${version}_${environment}`).size === 1) {
              // if removing last service, save it to separate buffer
              // this service will be returned, if no other services are present
              this.lastKnownServices.set(`${serviceName}_${version}_${environment}`, this.serviceInstances.get(`${serviceName}_${version}_${environment}`).get(`${nodeKey}/url`));
              this.lastKnownVersions.set(`${serviceName}_${environment}`, version);
            }
            this.serviceInstances.get(`${serviceName}_${version}_${environment}`).delete(`${nodeKey}/url`);
          }

          if (this.isKeyForVersions(key)) {
            if (this.serviceVersions.has(`${serviceName}_${environment}`)) {
              let versions = this.serviceVersions.get(`${serviceName}_${environment}`);

              if (versions.includes(version) && this.serviceInstances.get(`${serviceName}_${version}_${environment}`) && this.serviceInstances.get(`${serviceName}_${version}_${environment}`).size === 0) {
                // version was removed and no other instances of this version exist, remove version
                versions = versions.filter(v => v !== version);

                this.serviceVersions.set(`${serviceName}_${environment}`, versions);
              } else if (!versions.includes(version) && (!this.serviceInstances.has(`${serviceName}_${version}_${environment}`) || this.serviceInstances.get(`${serviceName}_${version}_${environment}`).size !== 0)) {
                versions.push(version);
                this.serviceVersions.set(`${serviceName}_${environment}`, versions);
              }
            }
          }
        }

        if (this.isKeyForVersions(key) || !this.serviceVersions.has(`${serviceName}_${environment}`)) {
          watch(res.node.modifiedIndex);
        }
      }
    };
    try {
      this.etcd.watch(key, { recursive: true, waitIndex: index, maxRetries: 0 }, callback);
    } catch (err) {
      console.error(`Exception when watching key: ${err}`);
    }
  }

  disableServiceInstance(serviceName, version, environment, url) {
    const key = getServiceKeyInstances(environment, serviceName, version);

    const etcdKeysResponseWhole = getEtcdDir(this.etcd, key, 1, this.resilience);
    if (!etcdKeysResponseWhole.err) {
      const etcdKeysResponse = etcdKeysResponseWhole.body;
      etcdKeysResponse.node.nodes.forEach(instance => {
        if (instance.nodes) {
          instance.nodes.forEach(node => {
            if (getLastKeyLayer(node.key) === 'url' && node.value === url) {
              console.info(`Disabling service instance ${instance.key}`);
              this.setEtcdKey(`${instance.key}/status`, 'disabled');
            }
          });
        }
      });
    }
  }

  setEtcdKey(key, value) {
    if (this.etcd) {
      const response = this.etcd.setSync(key, value);
      if (response.err) {
        if (this.resilience) {
          console.error(`Timeout exception. Cannot set given key in specified time or retry-count constraints: ${response.err}`);
        } else {
          throw new Error(`Timeout exception. Cannot set given key in specified time or retry-count constraints: ${response.err}`);
        }
      }
    } else {
      console.error('etcd not initialised');
    }
  }

  isKeyForVersions(key) {
    return key.split('/').length === 5;
  }

  getKeyOneLayerUp(key) {
    key = key.split('/');
    let newKey = '';
    for (let ind = 0; ind < key.length - 1; ind++) {
      newKey = `${newKey}${key[ind]}/`;
    }
    return newKey;
  }

  getServiceNameFromKey(key) {
    const splitted = key.split('/');
    return (splitted.length < 4) ? null : splitted[4];
  }

  getVersionFromKey(key) {
    const splitted = key.split('/');
    return (splitted.length < 5) ? null : splitted[5];
  }

  getEnvironmentFromKey(key) {
    const splitted = key.split('/');
    return (splitted.length < 2) ? null : splitted[2];
  }

  getServiceKeyVersions(serviceName, environment) {
    return `/environments/${environment}/services/${serviceName}`;
  }

  getGatewayKey(environment, serviceName, version) {
    return `/environments/${environment}/services/${serviceName}/${version}/gatewayUrl`;
  }
}

export default new EtcdDiscoveryUtil();
