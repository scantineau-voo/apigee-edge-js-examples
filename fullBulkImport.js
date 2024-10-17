#! /usr/local/bin/node

const apigeejs   = require('apigee-edge-js'),
      util       = require('util'),
      common     = apigeejs.utility,
      apigee     = apigeejs.apigee,
      sprintf    = require('sprintf-js').sprintf,
      fs         = require('fs'),
      path       = require('path'),
      mkdirp     = require('mkdirp'),
      Getopt     = require('node-getopt'),
      version    = '20240925-1052',
      defaults   = {
        entity : 'all'
      },
      getopt     = new Getopt(common.commonOptions.concat([
          ['t' , 'trial', 'trial only. Do not actually export'],
          ['D' , 'destination=ARG', 'directory where to find exports'],
          ['E' , 'entity=ARG', 'entity to import (apps, products, proxies, sharedflows, kvms, targetservers, references, keystores). Default: all'],
          ['e' , 'env=ARG', 'environment.']
      ])).bindHelp();

// process.argv array starts with 'node' and 'scriptname.js'
var opt = getopt.parse(process.argv.slice(2));
common.verifyCommonRequiredParameters(opt.options, getopt);

var summary = {};

if (opt.options.verbose) {
  console.log(
    'Apigee full bulk import tool based on full bulk export tool, version: ${version}\n' +
      'Node.js ${process.version}\n');

  common.logWrite('start');
}

function timeString() {
  return (new Date())
    .toISOString()
    .replace(/[-:]/g,'')
    .replace(/T/,'-')
    .replace(/\.\d\d\dZ$/,'');
}

function listExported(type){
  return new Promise ( (resolve, reject) => {resolve(fs.readdirSync(path.join(opt.options.destination, type)))});
}

function readFileAsJson(type, filename){
  return new Promise ( (resolve, reject) => {resolve(readFile(type, filename).then(data => JSON.parse(data)))});
}

function readFile(type, filename){
  return new Promise ( (resolve, reject) => {resolve(fs.readFileSync(path.join(opt.options.destination, type, filename), 'utf8'))});
}

function importAssets(org, type){
  let collection = (type == "sharedflows") ? "sharedFlows" : type;
  listExported(type).then(filenames =>
      org[type].get({}).then(existingAssetsResponse =>{
      let existingAssets = [];
      if (existingAssetsResponse && existingAssetsResponse[collection]){
        existingAssets = existingAssetsResponse[collection].map((a) => a.name);
      }
      filenames.forEach(filename =>{
        let assetName = path.parse(filename).name,
            filepath = path.join(opt.options.destination, type, filename);
        if (existingAssets.indexOf(assetName) == -1){
          org[type].import({name:assetName, source:filepath})
          .then(dontcare => org[type].deploy({ name: assetName, environment: opt.options.env }))
          .catch( e => console.error('error: ' + util.format(e) ) );
        } else {
          common.logWrite('%s "%s" already exists. Will only try to deploy it', type, assetName);
          org[type].deploy({ name: assetName, environment: opt.options.env })
            .catch( e => console.error('error: ' + util.format(e) ) );
        }
      })
    })
  );
}

if ( ! opt.options.entity) {
  opt.options.entity = defaults.entity;
}
apigee.connect(common.optToOptions(opt))

  .then(org => {
    if(opt.options.entity == "DELETE_developerapps"){
      org.developers.get({}).then(developers => {
        developers.developer.map(d => d.email).forEach(email =>{
          org.developerapps.get({email:email}).then(apps =>{
            if (apps && apps.app){
              deleted = true;
              apps.app.forEach(app => org.developerapps.del({app:app.appId, email}))
            }
          })}
        )
      })
    }
    return org;
  })

  .then(org => {
    if(opt.options.entity == "all" || opt.options.entity == "developerapps"){
      org.developers.get({}).then(developers => {
        let type = "developerapps",
        email = developers.developer[0].email; // Will take the first one we find and will fail if no one exist.
        listExported(type)
          .then(filenames => {
              filenames.forEach(filename => readFileAsJson(type, filename).then(data => {
                //
                // api management cannot let you define the developer id when you create it.
                // Since the app is linked to developer with it's id, this won't be handled automatically
                //
                //
                // Force the developerId with the first one found just before
                //
                Object.assign(data, { email });
                // create an app with a default credential without any proxies
                org.developerapps.import(data).then(badlyCreated =>{
                  let promises = []
                  // add all migrated credentials.
                  data.credentials.forEach(credential => {
                    if(credential.status != "revoked" && (Date.now() < credential.expiresAt || credential.expiresAt == -1)){
                      promises.push(org.appcredentials.add({
                        email,
                        appName: data.name,
                        apiProducts: credential.apiProducts.map(c => c.apiproduct),
                        consumerKey: credential.consumerKey,
                        consumerSecret: credential.consumerSecret,
                        expiresInSeconds: credential.expiresAt == -1 ? -1 : Math.round((credential.expiresAt - Date.now()) / 1000)
                      })
                      .catch( e => console.error('error: ' + util.format(e) ) ));
                    }
                  });
                  // when all known credentials are created, delete the one automatically created.
                  Promise.all(promises).then(dontcare => {
                    return org.appcredentials.del({
                     email,
                     appName: data.name,
                     key: badlyCreated.credentials.filter(c => !c.apiProducts)[0].consumerKey
                    })
                    .catch( e => console.error('error: ' + util.format(e) ) )
                  })
                  .catch( e => console.error('error: ' + util.format(e) ) );
                })
                .catch( e => console.error('error: ' + util.format(e) ) );
            }))
          })
      });
    }
    return org;
  })
  .then(org => {
    if(opt.options.entity == "all" || opt.options.entity == "products"){
      let type = "products";
      listExported(type)
        .then(filenames =>
          org.products.get({}).then(productsResponse => {
          let products = (productsResponse && productsResponse.apiProduct) ? productsResponse.apiProduct.map((a) => a.name) : [];
            filenames.forEach(filename => readFileAsJson(type, filename).then(data => {
              if(products.indexOf(data.name) == -1){
                org.products.create(data)
                .catch( e => console.error('error: ' + util.format(e) ) );
              } else {
                common.logWrite('Product "%s" already exists', data.name);
              }
            }))
          })
        );
    }
    return org;
  })
//
// api management cannot let you define the developer id.
// Since the app is linked to developer with it's id, this won't be handled automatically
//
//  .then(org => {
//    if(opt.options.entity == "all" || opt.options.entity == "developers"){
//      let type = "developers";
//      listExported(type)
//        .then(filenames =>
//          org.developers.get({}).then(response => {
//          console.log(response)
//          let developers = (response && response.developer) ? response.developer.map((a) => a.email.toLowerCase()) : [];
//          console.log(developers)
//            filenames.forEach(filename => readFileAsJson(type, filename).then(data => {
//              if(developers.indexOf(data.email.toLowerCase()) == -1){
//                org.developers.create(data)
//                .catch( e => console.error('error: ' + util.format(e) ) );
//              } else {
//                common.logWrite('Developer "%s" already exists', data.email);
//              }
//            }))
//          })
//        );
//    }
//    return org;
//  })
  .then(org => {
    if(opt.options.entity == "all" || opt.options.entity == "sharedflows"){
      importAssets(org, "sharedflows")
    }
    return org;
  })
  .then(org => {
    if(opt.options.entity == "all" || opt.options.entity == "proxies"){
      importAssets(org, "proxies")
    }
    return org;
  })
  .then(org => {
    if(opt.options.entity == "all" || opt.options.entity == "kvms"){
      let type = "kvms";
      listExported(type)
        .then(filenames =>
          org.kvms.get({"env": opt.options.env}).then(kvms =>
            filenames.forEach(filename => readFileAsJson(type, filename).then(data => {
              if(kvms.indexOf(data.name) == -1){
                org.kvms.create({"env": opt.options.env, "kvm": data.name});
              } else {
                common.logWrite('Kvm "%s" already exists', data.name);
              }
              if(data.entry && data.entry.length > 0){
                data.entry.forEach(entry => org.kvms.put({"env": opt.options.env, "kvm": data.name, "key": entry.name, "value":entry.value})
                  .catch( e => console.error('error: ' + util.format(e) ) )
                );
              }
            }))
          )
        );
    }
    return org;
  })
  .then(org => {
    if(opt.options.entity == "all" || opt.options.entity == "keystores"){
      let type = "keystores",
      environment = opt.options.env;
      listExported(type)
        .then(filenames =>
          org.keystores.get({environment}).then(keystores =>
            filenames.forEach(filename => readFileAsJson(type, filename).then(data => {
              let keystore = data.name;
              if(keystores.indexOf(data.name) == -1){
                org.keystores.create({environment, keystore});
              } else {
                common.logWrite('Keystore "%s" already exists', keystore);
              }
              if (data.aliases && data.aliases.length > 0){
                org.keystores.getAliases({environment, keystore}).then(existingAliases => {
                  data.aliases.forEach(alias => {
                    if(existingAliases.indexOf(alias.aliasName) == -1){
                      p = [];
                      p.push(readFile("certificates", alias.cert + ".crt"));
                      if (alias.key && alias.key.length > 0){
                        p.push(readFile("certificates", alias.key + ".key"));
                      }
                      Promise.all(p).then(values => {
                        let cert = values[0],
                            key = null;
                        if (values.length > 1){
                          key = values[1];
                        }
                        org.keystores.importCert({environment, keystore, cert, key, "alias": alias.aliasName});
                      })
                      .catch( e => console.error('error: ' + util.format(e) ) );
                    } else {
                      common.logWrite('Alias "%s" already exists', alias.aliasName);
                    }
                  });
                });
              }
            }))
          )
        );
    }
    return org;
  })
  .then(org => {
    if(opt.options.entity == "all" || opt.options.entity == "targetservers"){
      let type = "targetservers";
      listExported(type)
        .then(filenames =>
          org.targetservers.get({"env": opt.options.env}).then(targetservers =>
            filenames.forEach(filename => readFileAsJson(type, filename).then(data => {
              if(targetservers.indexOf(data.name) == -1){
                org.targetservers.create({"env": opt.options.env, "targetserver": data})
                .catch( e => console.error('error: ' + util.format(e) ) );
              } else {
                common.logWrite('Target Server "%s" already exists', data.name);
              }
            }))
          )
        );
    }
    return org;
  })
//  .then(org => {
//      setTimeout(() => common.logWrite(JSON.stringify(summary, null, 2)), 20000)
//  })
  .catch( e => console.error('error: ' + util.format(e) ) );
