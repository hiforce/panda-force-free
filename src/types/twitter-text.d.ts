declare module "twitter-text" {
  export interface TweetParseResult {
    weightedLength: number;
    valid: boolean;
    permillage: number;
    validRangeStart: number;
    validRangeEnd: number;
    displayRangeStart: number;
    displayRangeEnd: number;
  }
  interface TwitterText {
    parseTweet(text: string): TweetParseResult;
    extractUrlsWithIndices(text: string): { url: string; indices: [number, number] }[];
  }
  const twitterText: TwitterText;
  export default twitterText;
}
