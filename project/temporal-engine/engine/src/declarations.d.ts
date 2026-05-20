declare module 'turndown' {
  const TurndownService: any;
  export default TurndownService;
}
declare module 'jsdom' {
  export const JSDOM: any;
}
declare module '@mozilla/readability' {
  export const Readability: any;
}
declare module 'duck-duck-scrape' {
  export function search(query: string, opts?: any): Promise<any>;
  export const SafeSearchType: any;
}
