const { createRegionCatalog } = require('./region-catalog');

const SKIP_COUNTRY_IDS = new Set(['russia', 'us']);

function createCountrySubregionsCatalog(options: LooseRecord = {}) {
  const regionCatalog = options.regionCatalog || createRegionCatalog(options);

  async function getCountries() {
    return regionCatalog.listCountries();
  }

  async function getCountry(countryId: string) {
    return regionCatalog.getCountry(countryId);
  }

  async function findByExtractId(extractId: string) {
    return regionCatalog.findCountryByExtractId(extractId);
  }

  async function refresh() {
    return regionCatalog.listCountries();
  }

  return {
    getCountries,
    getCountry,
    findByExtractId,
    refresh,
    SKIP_COUNTRY_IDS
  };
}

module.exports = {
  createCountrySubregionsCatalog,
  SKIP_COUNTRY_IDS
};
