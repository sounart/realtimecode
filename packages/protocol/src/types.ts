export type BoundaryReason =
  | 'silence'
  | 'hotkey_release'
  | 'max_duration'
  | 'manual_commit'
  | 'semantic_completion';

export type UtteranceMetadata = {
  timestamp: string;
  confidence: number;
  boundaryReason: BoundaryReason;
  activeFileContext?: string[];
};

export type SparkProfile = 'default' | 'safe' | 'fast';
