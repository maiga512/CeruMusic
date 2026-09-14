export type MediaPermissionKind = 'microphone' | 'system-audio'

export type MediaPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

export type PermissionGuideTarget = 'microphone' | 'screen-recording' | 'files-and-folders'

export type AppPlatform = 'darwin' | 'win32' | 'linux' | 'other'
