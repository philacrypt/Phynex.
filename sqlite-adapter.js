const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

class SqliteAdapter {
    constructor(dbPath) {
        this.path = dbPath;
        this.db = new DatabaseSync(dbPath || ":memory:");
    }

    exec(sql) {
        return this.db.exec(sql);
    }

    pragma(sql) {
        const statementSql = /^\s*PRAGMA\b/i.test(sql || "") ? sql : "PRAGMA " + sql;
        const statement = this.db.prepare(statementSql);
        const row = statement.get();
        if (row !== undefined) return row;
        return statement.all();
    }

    prepare(sql) {
        return this.db.prepare(sql);
    }

    transaction(fn) {
        const self = this;
        return function () {
            self.db.exec("BEGIN");
            try {
                const result = fn.apply(this, arguments);
                self.db.exec("COMMIT");
                return result;
            } catch (error) {
                self.db.exec("ROLLBACK");
                throw error;
            }
        };
    }
}

module.exports = SqliteAdapter;
