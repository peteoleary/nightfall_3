import React from 'react';
import { Route, Redirect, Switch } from 'react-router-dom';
import { connect } from "react-redux";

import Transactions from './transactions/transactions.view';
import Login from './login/login.view'
import { setEnvironment } from '../utils/lib/environment';
import { DEFAULT_ENVIRONMENT, NF3_GITHUB_ISSUES_URL } from '../constants'
import * as loginActions from '../store/login/login.actions';


function App({ 
  onDeleteWallet,
}) {

  setEnvironment(DEFAULT_ENVIRONMENT);

  // Detect page refresh
  React.useEffect(() => {
    window.addEventListener("beforeunload", () => {
      onDeleteWallet();
    });
  }, [onDeleteWallet]);

  // TODO:Detect network is online/offline

  // Detect accounts changed and chain changed on metamask
  React.useEffect(() => {
    if (window.ethereum) {
      window.ethereum.on("accountsChanged", () => {
        onDeleteWallet();
      });
      window.ethereum.on("chainChanged", () => {
        onDeleteWallet();
      });
    }
  }, [onDeleteWallet]);

  return (
    <React.Fragment>
      <Switch>
        <Route path="/login" render={() => <Login />} />
        <Route path="/transactions" render={() => <Transactions />} />
        <Route path="/issues" render={() => (window.location = NF3_GITHUB_ISSUES_URL)} />
        <Redirect to="/login" />
      </Switch>
    </React.Fragment>
  );
}

const mapStateToProps = (state) => ({
  login: state.login,
});

const mapDispatchToProps = (dispatch) => ({
  onDeleteWallet: () => dispatch(loginActions.deleteWallet()),
})

export default connect(mapStateToProps, mapDispatchToProps)(App);
