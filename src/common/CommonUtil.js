import semver from 'semver';

class CommonUtils {
  lastInstanceServedIndex = 0

  async determineVersion(discoveryUtil, serviceName, version, environment) {
    if (!semver.validRange(version) && !semver.valid(version)) return version;

    if (!version.includes('*') && !version.includes('x')) return version;

    const versionsOpt = await discoveryUtil.getServiceVersions(serviceName, environment);
    if (versionsOpt) {
      const sortedVersions = versionsOpt.sort((v1, v2) => semver.rcompare(v1, v2));

      for (let i = 0; i < sortedVersions.length; i++) {
        if (semver.satisfies(sortedVersions[i], version)) {
          return sortedVersions[i];
        }
      }
    }
    return version;
  }

  pickServiceInstanceRoundRobin(serviceInstances) {
    if (serviceInstances.length > 0) {
      let index = 0;
      if (serviceInstances.length >= this.lastInstanceServedIndex + 2) {
        index = this.lastInstanceServedIndex + 1;
      }
      this.lastInstanceServedIndex = index;

      return serviceInstances[index] || null;
    }

    return null;
  }
}

export default new CommonUtils();
