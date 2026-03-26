const { createBuildingEditsContext } = require('./building-edits/shared');
const { createBuildingEditHistoryService } = require('./building-edits/history');
const { createBuildingEditModerationService } = require('./building-edits/moderation');
const { createBuildingEditPersonalOverlaysService } = require('./building-edits/personal-overlays');

function createBuildingEditsService({ db, normalizeUserEditStatus }) {
  const context = createBuildingEditsContext({ db, normalizeUserEditStatus });
  const historyService = createBuildingEditHistoryService(context);
  const moderationService = createBuildingEditModerationService(context, {
    getUserEditDetailsById: historyService.getUserEditDetailsById
  });
  const personalOverlaysService = createBuildingEditPersonalOverlaysService(context);

  // Preserve the legacy runtime contract while internal domains live in separate modules.
  return {
    ARCHI_EDIT_FIELDS: context.ARCHI_EDIT_FIELDS,
    ARCHI_FIELD_SET: context.ARCHI_FIELD_SET,
    getMergedInfoRow: context.getMergedInfoRow,
    getOsmContourRow: context.getOsmContourRow,
    getLatestUserEditRow: context.getLatestUserEditRow,
    supersedePendingUserEdits: context.supersedePendingUserEdits,
    getSessionEditActorKey: context.getSessionEditActorKey,
    applyUserEditRowToInfo: context.applyUserEditRowToInfo,
    getUserEditsList: historyService.getUserEditsList,
    getUserEditDetailsById: historyService.getUserEditDetailsById,
    reassignUserEdit: moderationService.reassignUserEdit,
    deleteUserEdit: moderationService.deleteUserEdit,
    withdrawPendingUserEdit: moderationService.withdrawPendingUserEdit,
    getUserPersonalEditsByKeys: personalOverlaysService.getUserPersonalEditsByKeys,
    mergePersonalEditsIntoFeatureInfo: personalOverlaysService.mergePersonalEditsIntoFeatureInfo,
    applyPersonalEditsToFilterItems: personalOverlaysService.applyPersonalEditsToFilterItems
  };
}

module.exports = {
  createBuildingEditsService
};
