import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // The API owns all state. Never prerender or cache session/payment responses.
};
export default config;
