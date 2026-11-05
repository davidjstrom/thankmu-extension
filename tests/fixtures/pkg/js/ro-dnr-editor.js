// uBO Lite read-only DNR editor
class Ed {
    exportToFile(text) {
        return super.exportToFile(text, `${this.id}-dnr-ruleset.json`);
    }
}
