/* eslint-disable global-require */
const { addBeforeLoader, loaderByName } = require('@craco/craco');
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () {
  return this.toString();
};

module.exports = {
  plugins: [{ plugin: require('@semantic-ui-react/craco-less') }],
  webpack: {
    configure: (webpackConfig, { paths }) => {
      const wasmExtensionRegExp = /\.wasm$/;
      const appConfig = require('../config/default');

      webpackConfig.resolve.extensions.push('.wasm');

      // eslint-disable-next-line no-param-reassign
      webpackConfig.externals = webpackConfig.externals || {};
      // eslint-disable-next-line no-param-reassign
      webpackConfig.externals.config = JSON.stringify(appConfig);

      webpackConfig.module.rules.forEach(rule => {
        (rule.oneOf || []).forEach(oneOf => {
          if (oneOf.loader && oneOf.loader.indexOf('file-loader') >= 0) {
            oneOf.exclude.push(wasmExtensionRegExp);
          }
        });
      });

      const wasmLoader = {
        test: wasmExtensionRegExp,
        include: paths.appSrc,
        loader: require.resolve('wasm-loader'),
        options: {},
      };
      addBeforeLoader(webpackConfig, loaderByName('file-loader'), wasmLoader);
      return webpackConfig;
    },
  },
};
