// The settings page's controller. Emby loads it by the name the page's data-controller
// gives, which Plugin.GetPages serves this file under.
define([], () => {
  // Plugin.Id. Another id loads an empty form that saves nothing.
  var pluginId = '8dd4c65a-eac6-4d61-88c5-779ed9c3539e';

  function failed(message) {
    Dashboard.hideLoadingMsg();
    Dashboard.alert({ message: message });
  }

  return (view) => {
    view.addEventListener('viewshow', () => {
      Dashboard.showLoadingMsg();
      ApiClient.getPluginConfiguration(pluginId).then(
        (config) => {
          view.querySelector('#LookUpOnPlay').checked = config.LookUpOnPlay;
          view.querySelector('#PerLanguage').value = config.PerLanguage;
          view.querySelector('#ApiBase').value = config.ApiBase;
          Dashboard.hideLoadingMsg();
        },
        () => {
          failed('The settings could not be loaded.');
        },
      );
    });

    view.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      Dashboard.showLoadingMsg();
      ApiClient.getPluginConfiguration(pluginId)
        .then((config) => {
          config.LookUpOnPlay = view.querySelector('#LookUpOnPlay').checked;
          config.PerLanguage = parseInt(view.querySelector('#PerLanguage').value, 10);
          config.ApiBase = view.querySelector('#ApiBase').value;
          return ApiClient.updatePluginConfiguration(pluginId, config);
        })
        .then(Dashboard.processPluginConfigurationUpdateResult, () => {
          failed('The settings could not be saved.');
        });
      return false;
    });
  };
});

// The name the browser gives this script's errors.
//# sourceURL=subtitledb.js
