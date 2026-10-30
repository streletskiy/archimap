let revision = 0;

function getBuildingDataRevision() { return revision; }
function advanceBuildingDataRevision() { revision++; }

module.exports = { getBuildingDataRevision, advanceBuildingDataRevision };
