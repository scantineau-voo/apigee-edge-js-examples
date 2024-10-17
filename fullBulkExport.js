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
      RETRY_DELAY= 1000,
      MAX_RETRY= 10,
      defaults   = {
        destination : 'exported-' + timeString(),
        entity : 'all',
      },
      getopt     = new Getopt(common.commonOptions.concat([
          ['t' , 'trial', 'trial only. Do not actually export'],
          ['D' , 'destination=ARG', 'directory for export. Default: exported'],
          ['E' , 'entity=ARG', 'entity to export (apps, products, proxies, sharedflows, kvms, targetservers, references, keystores). Default: all'],
          ['e' , 'env=ARG', 'environment']
      ])).bindHelp();

// process.argv array starts with 'node' and 'scriptname.js'
var opt = getopt.parse(process.argv.slice(2));
common.verifyCommonRequiredParameters(opt.options, getopt);

var summary = {};

if (opt.options.verbose) {
  console.log(
    'Apigee full bulk export tool, version: ${version}\n' +
      'Node.js ${process.version}\n' +
      'Limitations:\n' +
      '- Not able to extract encrypted kvms\n' +
      '- Not able to export tls keystore\'s keys\n' +
      '- Kvm attached to organization not implemented');

  common.logWrite('start');
}

function timeString() {
  return (new Date())
    .toISOString()
    .replace(/[-:]/g,'')
    .replace(/T/,'-')
    .replace(/\.\d\d\dZ$/,'');
}

function exportToJsonFile(type, id, content) {
  return exportToFile(type, id + ".json", JSON.stringify(content));
}

function exportToFile(type, filename, content) {
  return new Promise( (resolve, reject) => {
    let fullDirectory = path.join(opt.options.destination, type);
    let fullFilename = path.join(fullDirectory, filename);
    if (opt.options.trial) {
      common.logWrite('WOULD EXPORT HERE; %s', fullFilename);
      return resolve(fullFilename);
    }

    if (opt.options.verbose) {
        common.logWrite('Exporting to file "%s"', fullFilename);
    }

    mkdirp.sync(fullDirectory);
    fs.writeFileSync(fullFilename, content);
    return resolve(fullFilename);
  });
}

function exportOneRevision(org, type, name, revision) {
  return new Promise( (resolve, reject) => {
    if (! revision){
        common.logWrite(sprintf('No revision deployed in %s for the proxy "%s" ', opt.options.env, name));
        return resolve(name);
    }
    let fullDirectory = path.join(opt.options.destination, type);
    let fullFilename = path.join(fullDirectory, name + ".zip");

    if (opt.options.trial) {
      common.logWrite('WOULD EXPORT HERE; %s, revision:%s', fullFilename, revision);
      return resolve(fullFilename);
    }

    if (opt.options.verbose) {
        common.logWrite('Exporting to file "%s"', fullFilename);
    }

    mkdirp.sync(fullDirectory);

    return org[type].export({name:name, revision:revision})
      .then(result => {
        fs.writeFileSync(fullFilename, result.buffer);
        return resolve(fullFilename);
      });
  });
}

function addToSummary(options){
//console.log(JSON.stringify(options));
    if (! summary[options.name]){
    summary[options.name] = {};
    }
    if(options.found){
        summary[options.name]["found"] = (summary[options.name]["found"] || 0) + options.found;
    }
    if(options.exported){
        summary[options.name]["exported"] = (summary[options.name]["exported"] || 0) + options.exported;
    }
}

if ( ! opt.options.destination) {
  opt.options.destination = defaults.destination;
}

if ( ! opt.options.entity) {
  opt.options.entity = defaults.entity;
}

if ( (opt.options.entity == "proxies" || opt.options.entity == "all") && ! opt.options.env) {
    console.log('You must specify the environment when exporting a proxy');
    process.exit(1);
}

if ( (opt.options.entity == "sharedflows" || opt.options.entity == "all") && ! opt.options.env) {
    console.log('You must specify the environment when exporting a shared flow');
    process.exit(1);
}

if ( ! opt.options.trial) {
  mkdirp.sync(opt.options.destination);
}

const findDeployedRevision = (org, type, name) =>
 org[type].getDeployments({name})
  .then( deployment => {
     let deploymentInThisEnv = deployment.environment.filter(byEnv => byEnv.name == opt.options.env);
     if (deploymentInThisEnv && deploymentInThisEnv.length){
          let revisions = deploymentInThisEnv[0].revision.filter( r => r.state == 'deployed');
          // Today there is just one deployed revision. In the future there may be
          // more than one. Just choose the first one.
          return revisions && revisions.length && revisions[0].name;
     } else {
        return null;
     }
  })
  .catch(e => null);

const exportCertificate = async (org, env, name, cert, retries, delay) => {
  org.keystores.exportCert({env, name, cert})
  .then(certificate => {
    exportToFile("certificates", cert + ".crt", certificate);
    addToSummary({"name":"certificates", "exported": 1});
  })
  .catch( e => {
    console.error (sprintf("Error while exporting certificate %s in %s. Retrying ", name, cert));
    if (retries > 0) {
      new Promise(resolve => setTimeout(resolve, delay))
      .then(_ => exportCertificate(org, env, name, cert, retries - 1, delay * 2));
    } else {
      throw new Error('All retries failed');
    }
  });
};


apigee.connect(common.optToOptions(opt))
//
// api management cannot let you define the developer id.
// Since the app is linked to developer with it's id, this won't be handled automatically
//
//    .then(org => {
//        if(opt.options.entity == "all" || opt.options.entity == "developers"){
//            org.developers.get({})
//                .then(resp => {
//                    addToSummary({"name":"developers", "found": resp.length});
//                    resp.forEach(devEmail => {
//                        org.developers.get({"id": devEmail})
//                            .then(dev => {
//                                exportToJsonFile("developers", devEmail, dev);
//                                addToSummary({"name":"developers", "exported": 1});
//                            })
//                    })
//                })
//        }
//        return org;
//    })
    .then(org => {
        if(opt.options.entity == "all" || opt.options.entity == "apps"){
            org.apps.get({})
                .then(resp => {
                    addToSummary({"name":"apps", "found": resp.length});
                    resp.forEach(appId => {
                        org.apps.get({"id": appId})
                            .then(app => {
                                exportToJsonFile("apps", appId, app);
                                addToSummary({"name":"apps", "exported": 1});
                            })
                    })
                })
        }
        return org;
    })
    .then(org => {
        if(opt.options.entity == "all" || opt.options.entity == "developerapps"){
            org.developers.get({})
                .then(respDev => {
                    respDev.forEach(email => {
                      org.developerapps.get({email})
                          .then(resp => {
                              addToSummary({"name":"developerapps", "found": resp.length});
                              resp.forEach(name => {
                                  org.developerapps.get({email, name})
                                      .then(app => {
                                          exportToJsonFile("developerapps", app.name, app);
                                          addToSummary({"name":"developerapps", "exported": 1});
                                      })
                              })
                          })
                    })
                })
        }
        return org;
    })

    .then(org => {
        if(opt.options.entity == "all" || opt.options.entity == "products"){
            org.products.get({})
                .then(resp => {
                    addToSummary({"name":"products", "found": resp.length});
                    resp.forEach(productName => {
                        org.products.get({"name": productName})
                            .then(product => {
                                exportToJsonFile("products", productName, product);
                                addToSummary({"name":"products", "exported": 1});
                            })
                    })
                })
        }
        return org;
    })
    .then(org => {
        if(opt.options.entity == "all" || opt.options.entity == "proxies"){
            org.proxies.get({})
                .then(resp => {
                  let proxies = (resp.proxies) ? resp.proxies.map(p => p.name) : resp;
                    addToSummary({"name":"proxies", "found": resp.length});
                  common.logWrite(sprintf('found %d proxies', proxies.length));
                  return proxies;
                })
                .then( proxies => {
                  let type = "proxies"
                  let reducer = (p, artifactName) =>
                      p.then( a =>
                              findDeployedRevision(org, type, artifactName)
                              .then(rev =>
                                    exportOneRevision(org, type, artifactName, rev)
                                    .then( filename => {
                                addToSummary({"name":"proxies", "exported": 1});
                                    return [ ...a, {artifactName, filename} ]
                                    } )));
                  return proxies
                    .reduce(reducer, Promise.resolve([]));
                });
        }
        return org;
    })
    .then(org => {
        if(opt.options.entity == "all" || opt.options.entity == "sharedflows"){
            org.sharedflows.get({})
                .then(resp => {
                  let sharedflows = (resp.sharedflows) ? resp.sharedflows.map(p => p.name) : resp;
                    addToSummary({"name":"sharedflows", "found": resp.length});
                  common.logWrite(sprintf('found %d sharedflows', sharedflows.length));
                  return sharedflows;
                })
                .then( sharedflows => {
                  let type = "sharedflows"
                  let reducer = (p, artifactName) =>
                      p.then( a =>
                              findDeployedRevision(org, type, artifactName)
                              .then(rev =>
                                    exportOneRevision(org, type, artifactName, rev)
                                    .then( filename => {
                                addToSummary({"name":"sharedflows", "exported": 1});
                                    return [ ...a, {artifactName, filename} ]
                                    } )));
                  return sharedflows
                    .reduce(reducer, Promise.resolve([]));
                });
        }
        return org;
    })
    .then(org => {
        if(opt.options.entity == "all" || opt.options.entity == "kvms"){
            org.kvms.get({"env": opt.options.env})
                .then(resp => {
                    addToSummary({"name":"kvms", "found": resp.length});
                    common.logWrite(sprintf('found %d kvms', resp.length));
                    return resp;
                })
                .then(kvms => {
                    kvms.forEach(name => {
                        org.kvms.get({"env": opt.options.env, name})
                        .then(kvm => {
                            if (kvm.encrypted){
                                exportToJsonFile("encrypted_kvms", name, kvm);
                                addToSummary({"name":"encrypted_kvms", "exported": 1});
                                common.logWrite(sprintf('The kvm %s is encrypted', name));
                            } else {
                                exportToJsonFile("kvms", name, kvm);
                                addToSummary({"name":"kvms", "exported": 1});
                            }
                            return kvm;
                        })
                    })

                })
        }
        return org;
    })
    .then(org => {
        if(opt.options.entity == "all" || opt.options.entity == "targetservers"){
            org.targetservers.get({"env": opt.options.env})
                .then(resp => {
                    addToSummary({"name":"targetservers", "found": resp.length});
                    common.logWrite(sprintf('found %d targetservers', resp.length));
                    return resp;
                })
                .then(targetservers => {
                    targetservers.forEach(name => {
                        org.targetservers.get({"env": opt.options.env, name})
                        .then(targetserver => {
                            exportToJsonFile("targetservers", name, targetserver);
                            addToSummary({"name":"targetservers", "exported": 1});
                        })
                    })
                })
        }
        return org;
    })
    .then(org => {
        if(opt.options.entity == "all" || opt.options.entity == "keystores"){
            let env = opt.options.env;
            org.keystores.get({"environment": env})
                .then(resp => {
                    addToSummary({"name":"keystores", "found": resp.length});
                    common.logWrite(sprintf('found %d keystores', resp.length));
                    return resp;
                })
                .then(keystores => {
                    keystores.forEach(name => {
                        org.keystores.get({"environment": env, name})
                        .then(keystore => {
                            exportToJsonFile("keystores", name, keystore);
                            addToSummary({"name":"keystores", "exported": 1});
                            if(keystore.certs){
                              common.logWrite(sprintf('found %d certificate(s) in %s', keystore.certs.length, name));
                              addToSummary({"name":"certificates", "found": keystore.certs.length});
                              keystore.certs.forEach(cert => {
                                org.keystores.exportCert({env, name, cert})
                                  .then(certificate => {
                                    exportToFile("certificates", cert + ".crt", certificate);
                                    addToSummary({"name":"certificates", "exported": 1});
                                  })}
                              );
                            }
                        })
                    })
                });
        }
        return org;
    })
//    .then(org => {
//        setTimeout(() => common.logWrite(JSON.stringify(summary, null, 2)), 30000)
//    })
    .catch( e => console.error('error: ' + util.format(e) ) );
