/** @type {import('next').NextConfig} */
const nextConfig = {
  // `pg` is a native-ish Node package; keep it out of the server bundle so
  // Next doesn't try to trace/bundle its optional dependencies.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
