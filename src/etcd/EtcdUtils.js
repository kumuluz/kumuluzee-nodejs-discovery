export const getServiceKeyInstance = (environment, serviceName, version, serviceId) => `/environments/${environment}/services/${serviceName}/${version}/instances/${serviceId}`;
export const getServiceKeyInstances = (environment, serviceName, version) => `/environments/${environment}/services/${serviceName}/${version}/instances/`;

export const getLastKeyLayer = (key) => {
  const splitted = key.split('/');
  return splitted[splitted.length - 1];
};

export const getEtcdDir = (etcd, key, retryPolicy, resilience, startRetryDelay, maxRetryDelay) => {
  let retryCounter = 0;
  let currentRetryDelay = startRetryDelay;
  return new Promise ((resolve) => {
    const callback = (err, res, data) => {
      const get = () => {
        etcd.get(key, { recursive: true, maxRetries: 0 }, callback);
      };

      if (err && err.errorCode !== 100) {
        if (retryCounter >= retryPolicy && retryPolicy !== -1) {
          const message = 'Timeout exception. Cannot read given key in specified time or retry-count constraints.';
          if (resilience) {
            console.error(`${message} ${err}`);
          } else {
            throw new Error(`${message} ${err}`);
          }
          return resolve({ err, body: res, data });
        } else if (err.errorCode !== 100) {
          console.error(`Etcd exception: ${err}`);
        }

        retryCounter += 1;

        setTimeout(() => get(), currentRetryDelay);
        currentRetryDelay *= 2;
        if (currentRetryDelay > maxRetryDelay) {
          currentRetryDelay = maxRetryDelay;
        }
      } else {
        resolve({ err, body: res, data });
      }
    };

    etcd.get(key, { recursive: true, maxRetries: 0 }, callback);
  });
};
