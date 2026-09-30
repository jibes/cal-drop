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
 * The only thing that differs per person. Which endpoint, which model and who
 * pays are decisions the deployment makes once, not choices to put in front of
 * someone holding a poster.
 */
/**
 * Where the model is reached.
 *
 *   'proxy'  through the endpoint this build was given, which holds the API
 *            key and decides the model; an access code says who may use it
 *   'direct' straight to an OpenAI-compatible API of your own, with your own
 *            key and your own choice of model
 */
export type Method = 'proxy' | 'direct';

/**
 * Who reads a link, with an API of one's own. A browser may not fetch another
 * site and an OpenAI-compatible API has no route that does, so it takes a
 * service: none at all, Jina Reader (which sees the link), or a server of
 * one's own (fetcher/). Inside the app the device reads the page first, and
 * this is only the fallback.
 */
export type LinkReader = 'off' | 'jina' | 'server';

export interface Settings {
  method: Method;
  /** For 'proxy': what the shared endpoint asks for. */
  accessCode: string;
  /** For 'direct': the base URL, as in https://api.example.com/v1 */
  apiBase: string;
  apiKey: string;
  /** For 'direct': nothing else knows which model to ask for. */
  model: string;
  /**
   * For 'direct': the model asked when the request carries a picture, where
   * that is a different one. Empty means the same model reads both.
   */
  visionModel: string;
  /**
   * Somewhere that will read a web page and hand back its text — see
   * fetcher/. A browser cannot do it and an OpenAI-compatible API has no such
   * route, so without one a link cannot be read at all outside the app.
   */
  pageReader: string;
  pageReaderCode: string;
  /** For 'direct': which of the above reads a link; see LinkReader. */
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
