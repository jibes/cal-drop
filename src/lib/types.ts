export interface EventDraft {
  id: string;
  title: string;
  /** YYYY-MM-DD, local/floating date as printed on the source. */
  startDate: string;
  /** HH:MM (24h) or '' for an all-day event. */
  startTime: string;
  endDate: string;
  endTime: string;
  allDay: boolean;
  location: string;
  description: string;
  url: string;
  /** 0..1, the model's own confidence in the date it read. */
  confidence: number;
  /** Anything ambiguous the model wants the user to check. */
  notes: string;
}

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  textModel: string;
  corsProxy: string;
}

export type SourceKind = 'image' | 'pdf' | 'text' | 'url';

export interface ExtractionSource {
  kind: SourceKind;
  label: string;
  /** data: URLs for image sources (one per page/photo). */
  images: string[];
  /** Plain text for pdf/text/url sources. */
  text: string;
}
