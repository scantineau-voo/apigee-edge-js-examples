#! /usr/local/bin/node
/*jslint node:true */
// generateAndLoadKeysIntoKvm.js
// ------------------------------------------------------------------
// generate an RSA 256-bit keypair and load into Apigee Edge KVM
//
// Copyright 2017-2021 Google LLC.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// last saved: <2021-April-21 16:59:28>

const apigeejs = require('apigee-edge-js'),
      common   = apigeejs.utility,
      apigee   = apigeejs.edge,
      sprintf  = require('sprintf-js').sprintf,
      util     = require('util'),
      NodeRSA  = require('node-rsa'),
      uuidV4   = require('uuid/v4'),
      Getopt   = require('node-getopt'),
      version  = '20210421-1644',
      defaults = { privkeysmap : 'PrivateKeys', pubkeysmap: 'NonSecrets', kidmap: 'NonSecrets' },
      getopt   = new Getopt(common.commonOptions.concat([
        ['e' , 'env=ARG', 'required. the Edge environment'],
        ['r', 'regex=ARG', 'optional. only matching kvm name'],
        ['k', 'key=ARG', 'optional. only matching keys in kvms']
      ])).bindHelp();

// ========================================================

// process.argv array starts with 'node' and 'scriptname.js'
let opt = getopt.parse(process.argv.slice(2));

if (opt.options.verbose) {
  console.log(
    `Apigee Edge KVM exploring tool, version: ${version}\n` +
    `Node.js ${process.version}\n`);

  common.logWrite('start');
}

if ( !opt.options.env ) {
  console.log('You must specify an environment');
  getopt.showHelp();
  process.exit(1);
}

common.verifyCommonRequiredParameters(opt.options, getopt);

function searchKvms(org, {pattern, env}) {
  let re1 = (pattern) ? new RegExp(pattern) : null;

  return org.kvms.get({ env: opt.options.env })
    .then( kvms => {
      if (re1) {
        kvms = kvms.filter( a => a.match(re1) );
      }

      return kvms;
    });
}

function searchKeys(org, {pattern, env, kvmName}) {
  let re1 = (pattern) ? new RegExp(pattern) : null;

  return org.kvms.listEntries({ env: env, kvmName: kvmName })
    .then( keys => {
      if (re1) {
        keys = keys.filter( a => a.match(re1) );
      }

      return keys;
    });
}

apigee
  .connect(common.optToOptions(opt))
  .then(org => {
    common.logWrite('connected');

    return searchKvms(org, {pattern:opt.options.regex, env:opt.options.env})
      .then( result => {
        kvmsFinalResult = {};
        promises = [];
        result.forEach( kvmName => {
            promises.push(searchKeys(org, {pattern:opt.options.key, env:opt.options.env, kvmName:kvmName})
            .then( kvmResult => {
                if (kvmResult.length > 0){
                    kvmsFinalResult[kvmName] = kvmResult;
                }
            }));
        })
        Promise.all(promises).then(r => {
            common.logWrite('%s', JSON.stringify(kvmsFinalResult, null, 2));
        });
        return JSON.stringify(result, null, 2);
      })
      .catch( e => console.log('while executing, error: ' + util.format(e)) );
  })
  .catch( e => console.log('while executing, error: ' + util.format(e)) );
