export interface EventDraft {
  id: string;
  title: string;
  /** YYYY-MM-DD, as printed on the source. */
  startDate: string;
  /** HH:MM (24h), or '' for an all-day event. */
  startTime: string;
  endDate: string;
  endTime: string;
  allDay: boolean;
  location: string;
  /** IANA zone resolved from the venue, or '' to keep the time floating. */
  timezone: string;
  /** RRULE body without the "RRULE:" prefix, e.g. FREQ=WEEKLY;BYDAY=TU. */
  rrule: string;
  description: string;
  url: string;
  /** The exact words the date was read from, shown so a glance can verify it. */
  sourceText: string;
  /** 0..1, the model's own confidence in the date it read. */
  confidence: number;
  /** Anything ambiguous the reviewer should check. */
  notes: string;
}

/**
 * Who reads a link in a browser. A page may not fetch another site and an
 * OpenAI-compatible API has no route that does, so it takes a service: none
 * at all, Jina Reader (which sees the link), or a reader of one's own that
 * is called the way Jina is (fetcher/ is one). Inside the app the phone reads
 * the page itself and this is not used.
 */
export type LinkReader = 'off' | 'jina' | 'server';

/**
 * What differs per person: which OpenAI-compatible API is asked, with whose
 * key, for which model — and, in a browser, who reads links.
 */
export interface Settings {
  /** The base URL, as in https://api.example.com/v1 */
  apiBase: string;
  apiKey: string;
  /** Nothing else knows which model to ask for. */
  model: string;
  /**
   * The model asked when the request carries a picture, where that is a
   * different one. Empty means the same model reads both.
   */
  visionModel: string;
  /**
   * A reader of one's own: GET <pageReader>/<link> answers with the page's
   * text, as r.jina.ai does. pageReaderCode, if set, goes along as a Bearer
   * token.
   */
  pageReader: string;
  pageReaderCode: string;
  /** Which reader reads a link in a browser; see LinkReader. */
  linkReader: LinkReader;
  /** Optional: Jina's free tier is rate limited, a key lifts it. */
  jinaKey: string;
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
