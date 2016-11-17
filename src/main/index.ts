import {promisifyAll} from 'bluebird';
import {sync} from 'glob';
import {isAbsolute, join} from 'path';

const pluginName = 'seneca-sequelize';

const supportedCmds = [
  'create',
  'findOrCreate',
  'findById',
  'findOne',
  'findAll',
  'findAndCountAll',
  'count',
  'bulkCreate',
  'update',
  'destroy'
];

function getFunctions(model) {
  return Object.getOwnPropertyNames(model).filter(key => typeof model[key] === 'function');
}

function replaceModels(sequelize, payload) {

  if (payload.model) {
    payload.model = sequelize.models[payload.model];
  }

  if (payload.include) {
    payload.include = payload.include.map(inclusion => {
      return replaceModels(sequelize, inclusion);
    });
  }

  return payload;
}

function loadModels(roleName, modelsPath, seneca, sequelize) {
  let files = sync(modelsPath);
  
  let models = files.reduce((acc, file) => {
    let filePath = isAbsolute(file) ? file : join(process.cwd(), file);
    let model = sequelize.import(filePath);
    acc[model.name] = model;
    return acc;
  }, {});

  Object.keys(models).forEach(name => {
    let model = models[name];
    if (model.hasOwnProperty('associate')) {
      model.associate(models);
    }

    supportedCmds.forEach(command => {
      seneca.add({role: roleName, model: name, cmd: command}, (msg, done) => {

        let args = [];
        if (command !== 'update' && command !== 'create') {
          args.push(replaceModels(model.sequelize, msg.payload || {}));
        }
        else {
          args.push(msg.payload);
        }

        if (command === 'update') {
          args.push(replaceModels(model.sequelize, msg.query || {}));
        }

        model[command].apply(model, args).then((result) => {
          let finalResult;
          if (result === null) {
            finalResult = result;
          }
          else if (Array.isArray(result)) {
            finalResult = result.map(e => {
              return typeof e.toJSON === 'function' ? e.toJSON() : e;
            });
          }
          else if (typeof result === 'object' && typeof result.toJSON === 'function') {
            finalResult = result.toJSON();
          }
          else {
            finalResult = {result: result};
          }
          done(null, finalResult);
        })
        .catch(done);
      });
    });

  });

  return sequelize;
}

function loadHooks(hooksPath, seneca, sequelize) {
  let files = sync(hooksPath);

  files.forEach((file) => {
    let filePath = isAbsolute(file) ? file: join(process.cwd(), file);
    let hook = require(filePath);
    hook(seneca, sequelize);
  });
}

const upsert = (queue) => (msg, response) => {

  const model = msg.model;
  const query = msg.query;
  const payload = msg.payload;

  // Check if dataset exists.
  async function wrapper () {
    let req = {
      role: 'vault',
      model: model,
      cmd: 'findOne',
      payload: query
    };

    let exists = await queue.actAsync(req);

    let id;
    if (!exists) {
      let opts = {role: 'vault', model: model, cmd: 'create', payload: payload};
      return queue.actAsync(opts);
    } else {
      payload.id = exists.id;
      let opts = {
        role: 'vault',
        model: 'dataset',
        cmd: 'update',
        query: {
          where: {
            id: payload.id
          }
        },
        payload: payload
      };
      return queue.actAsync(opts);
    }
  }

  wrapper().then(res => response(null, res)).catch(err => response(err))

};

function plugin(options) {
  let seneca = this;
  promisifyAll(seneca);
  this.add({init: pluginName}, (args, done) => {
    let sequelize = options.sequelize;
    loadModels(options.roleName || 'crud', options.modelsPath, seneca, sequelize);
    seneca.add({role: options.roleName, cmd: 'query', query: '*'}, async (msg, rep) => {
      let results = await sequelize.query(msg.query, msg.payload);
      rep(null, results);
    });
    if (options.hooksPath) {
      loadHooks(options.hooksPath, seneca, sequelize);
    }
    console.log(`Plugin ${pluginName} loaded ${Object.keys(sequelize.models).length} models`);
    done();
  });

  this.add({ role: options.roleName, cmd: 'upsert', model: '*', payload: '*', query:'*'}, upsert(seneca));

  return pluginName;
}

export default plugin;
