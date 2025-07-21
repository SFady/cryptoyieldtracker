/** @type {import('next').NextConfig} */

const nextConfig = {
  env: {
    BUILD_DATE: new Date().toISOString(),
  },
};

export default nextConfig;
