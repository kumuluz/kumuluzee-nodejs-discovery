class InitializationUtils {
  async getStartRetryDelayMs(configurationUtil, implementation) {
    const universalConfig = await configurationUtil.get('kumuluzee.discovery.start-retry-delay-ms') || null;

    if (universalConfig) {
      return universalConfig;
    }

    return await configurationUtil.get(`kumuluzee.discovery.${implementation}.start-retry-delay-ms`) || 500;
  }

  async getMaxRetryDelayMs(configurationUtil, implementation) {
    const universalConfig = await configurationUtil.get('kumuluzee.discovery.max-retry-delay-ms') || null;

    if (universalConfig) {
      return universalConfig;
    }

    return await configurationUtil.get(`kumuluzee.discovery.${implementation}.max-retry-delay-ms`) || 900000;
  }
}

export default new InitializationUtils();
