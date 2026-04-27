const { withInfoPlist, withXcodeProject, withEntitlementsPlist } = require('@expo/config-plugins');

const LIVE_ACTIVITY_FILES = ['LiveActivityModule.swift', 'LiveActivityManager.swift'];

/**
 * expo-modules-autolinking이 Swift 파일을 잘못된 경로로 추가하는 버그를 수정.
 * prebuild 실행 시마다 올바른 경로(../modules/live-activity/ios/*)로 재설정.
 */
const withLiveActivityXcodeFiles = (config) => {
  return withXcodeProject(config, (mod) => {
    const xcodeProject = mod.modResults;
    const projectName = mod.modRequest.projectName; // 'subwaynow'

    const objects = xcodeProject.hash.project.objects;
    const fileRefs = objects['PBXFileReference'] ?? {};
    const buildFiles = objects['PBXBuildFile'] ?? {};

    // 앱 타겟 UUID 찾기
    const nativeTargets = objects['PBXNativeTarget'] ?? {};
    const targetEntry = Object.entries(nativeTargets).find(([uuid, target]) => {
      if (uuid.endsWith('_comment')) return false;
      return (target.name ?? '').replace(/"/g, '') === projectName;
    });
    const targetUUID = targetEntry?.[0];

    // 앱 타겟의 Sources 빌드 페이즈 UUID 찾기
    const sourcesBuildPhases = objects['PBXSourcesBuildPhase'] ?? {};
    let sourcesBuildPhase = null;
    let sourcesBuildPhaseUUID = null;
    if (targetUUID) {
      const target = nativeTargets[targetUUID];
      for (const phaseRef of target.buildPhases ?? []) {
        const phaseUUID = phaseRef.value ?? phaseRef;
        if (sourcesBuildPhases[phaseUUID]) {
          sourcesBuildPhase = sourcesBuildPhases[phaseUUID];
          sourcesBuildPhaseUUID = phaseUUID;
          break;
        }
      }
    }

    // 1. 기존 LiveActivity Swift 파일 참조를 모두 제거 (경로 오류 정리)
    for (const [uuid, ref] of Object.entries(fileRefs)) {
      if (uuid.endsWith('_comment')) continue;
      const name = (ref.name ?? '').replace(/"/g, '');
      if (!LIVE_ACTIVITY_FILES.includes(name)) continue;

      // 관련 build file 찾아서 제거
      for (const [bfUUID, bf] of Object.entries(buildFiles)) {
        if (bfUUID.endsWith('_comment') || bf.fileRef !== uuid) continue;
        // Sources 빌드 페이즈에서 제거
        if (sourcesBuildPhase) {
          sourcesBuildPhase.files = (sourcesBuildPhase.files ?? []).filter(
            (f) => (f.value ?? f) !== bfUUID,
          );
        }
        delete buildFiles[bfUUID];
        delete buildFiles[`${bfUUID}_comment`];
      }

      // PBXGroup에서 제거
      for (const group of Object.values(objects['PBXGroup'] ?? {})) {
        if (Array.isArray(group.children)) {
          group.children = group.children.filter((c) => (c.value ?? c) !== uuid);
        }
      }

      delete fileRefs[uuid];
      delete fileRefs[`${uuid}_comment`];
    }

    return mod;
  });
};

/** @type {import('@expo/config-plugins').ConfigPlugin} */
const withLiveActivity = (config) => {
  config = withInfoPlist(config, (mod) => {
    mod.modResults['NSSupportsLiveActivities'] = true;
    mod.modResults['NSSupportsLiveActivitiesFrequentUpdates'] = true;
    return mod;
  });
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults['com.apple.security.application-groups'] = ['group.com.subwaynow.app'];
    return mod;
  });
  config = withLiveActivityXcodeFiles(config);
  return config;
};

module.exports = withLiveActivity;
