import { URL } from 'url';

export const getConsulServiceKey = (serviceName, environment) => `${environment}-${serviceName}`;

const serviceHealthToUrl = (serviceHealth) => {
  try {
    const url = new URL(`${serviceHealth.Service.Tags.includes('https') ? 'https' : 'http'}://${serviceHealth.Node.Address}:${serviceHealth.Service.Port}`);
    return url.toString();
  } catch (err) {
    console.error(`Malformed URL when translating serviceHealth to URL: ${err}`);
  }
  return null;
};

export const getInstanceFromServiceHealth = (serviceHealth) => {
  const serviceUrl = serviceHealthToUrl(serviceHealth);
  if (serviceUrl) {
    let version = null;
    const TAG_VERSION_PREFIX = 'version=';

    serviceHealth.Service.Tags.forEach(tag => {
      if (tag.startsWith('version=')) {
        version = tag.substring(TAG_VERSION_PREFIX.length);
      }
    });

    if (!version) {
      version = '1.0.0';
    }

    return {
      id: serviceHealth.Service.ID,
      version,
      serviceUrl,
    };
  }
  return null;
};
