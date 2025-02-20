/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * 'License'); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * 'AS IS' BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/* global _ */

import { parse as parseCSVData } from 'csv-parse/lib/sync'
import { parse as parseYAMLData } from 'yaml'

/**
 * A service for parsing user-provided JSON, YAML, or JSON connection data into
 * an appropriate format for bulk uploading using the PATCH REST endpoint.
 */
angular.module('import').factory('connectionParseService',
        ['$injector', function connectionParseService($injector) {

    // Required types
    const Connection          = $injector.get('Connection');
    const DirectoryPatch      = $injector.get('DirectoryPatch');
    const ParseError          = $injector.get('ParseError');
    const ParseResult         = $injector.get('ParseResult');
    const TranslatableMessage = $injector.get('TranslatableMessage');

    // Required services
    const $q                     = $injector.get('$q');
    const $routeParams           = $injector.get('$routeParams');
    const schemaService          = $injector.get('schemaService');
    const connectionCSVService   = $injector.get('connectionCSVService');
    const connectionGroupService = $injector.get('connectionGroupService');

    const service = {};

    /**
     * The identifier of the root connection group, under which all other groups
     * and connections exist.
     * 
     * @type String
     */
    const ROOT_GROUP_IDENTIFIER = 'ROOT';

    /**
     * Perform basic checks, common to all file types - namely that the parsed
     * data is an array, and contains at least one connection entry. Returns an
     * error if any of these basic checks fails.
     *
     * @returns {ParseError}
     *     An error describing the parsing failure, if one of the basic checks
     *     fails.
     */
    function performBasicChecks(parsedData) {

        // Make sure that the file data parses to an array (connection list)
        if (!(parsedData instanceof Array))
            return new ParseError({
                message: 'Import data must be a list of connections',
                key: 'IMPORT.ERROR_ARRAY_REQUIRED'
            });

        // Make sure that the connection list is not empty - contains at least
        // one connection
        if (!parsedData.length)
            return new ParseError({
                message: 'The provided file is empty',
                key: 'IMPORT.ERROR_EMPTY_FILE'
            });
    }

    /**
     * Returns a promise that resolves to an object containing both a map of
     * connection group paths to group identifiers and a set of all known group
     * identifiers.
     *
     * The resolved object will contain a "groupLookups" key with a map of group
     * paths to group identifier, as well as a "identifierSet" key containing a
     * set of all known group identifiers.
     *
     * The idea is that a user-provided import file might directly specify a
     * parentIdentifier, or it might specify a named group path like "ROOT",
     * "ROOT/parent", or "ROOT/parent/child". The resolved "groupLookups" field
     * will map all of the above to the identifier of the appropriate group, if
     * defined. The "identifierSet" field can be used to check if a given group
     * identifier is known.
     *
     * @returns {Promise.<Object>}
     *     A promise that resolves to an object containing a map of group paths
     *     to group identifiers, as well as set of all known group identifiers.
     */
    function getGroupLookups() {

        // The current data source - defines all the groups that the connections
        // might be imported into
        const dataSource = $routeParams.dataSource;

        const deferredGroupLookups = $q.defer();

        connectionGroupService.getConnectionGroupTree(dataSource).then(
                rootGroup => {

            // An object mapping group paths to group identifiers
            const groupLookups = {};

            // An object mapping group identifiers to the boolean value true,
            // i.e. a set of all known group identifiers
            const identifierSet = {};

            // Add the specified group to the lookup, appending all specified
            // prefixes, and then recursively call saveLookups for all children
            // of the group, appending to the prefix for each level
            const saveLookups = (prefix, group) => {

                // To get the path for the current group, add the name
                const currentPath = prefix + group.name;

                // Add the current path to the lookup
                groupLookups[currentPath] = group.identifier;

                // Add this group identifier to the set
                identifierSet[group.identifier] = true;

                // Add each child group to the lookup
                const nextPrefix = currentPath + "/";
                _.forEach(group.childConnectionGroups,
                        childGroup => saveLookups(nextPrefix, childGroup));

            }

            // Start at the root group
            saveLookups("", rootGroup);

            // Resolve with the now fully-populated lookups
            deferredGroupLookups.resolve({ groupLookups, identifierSet });

        });

        return deferredGroupLookups.promise;
    }

    /**
     * Returns a promise that will resolve to a transformer function that will
     * take an object that may contain a "group" field, replacing it if present
     * with a "parentIdentifier". If both a "group" and "parentIdentifier" field
     * are present on the provided object, or if no group exists at the specified
     * path, the function will throw a ParseError describing the failure.
     *
     * The group may begin with the root identifier, a leading slash, or may omit
     * the root identifier entirely. Additionally, the group may optionally end
     * with a trailing slash.
     *
     * @returns {Promise.<Function<Object, Object>>}
     *     A promise that will resolve to a function that will transform a
     *     "group" field into a "parentIdentifier" field if possible.
     */
    function getGroupTransformer() {
        return getGroupLookups().then(({groupLookups, identifierSet}) =>
                connection => {

            const parentIdentifier = connection.parentIdentifier;

            // If there's no group path defined for this connection
            if (!connection.group) {

                // If the specified parentIdentifier is not specified
                // at all, or valid, there's nothing to be done
                if (!parentIdentifier || identifierSet[parentIdentifier])
                    return connection;

                // If a parent group identifier is present, but not valid
                if (parentIdentifier)
                    throw new ParseError({
                        message: 'No group with identifier: ' + parentIdentifier,
                        key: 'IMPORT.ERROR_INVALID_GROUP_IDENTIFIER',
                        variables: { IDENTIFIER: parentIdentifier }
                    });
            }

            // If both are specified, the parent group is ambigious
            if (parentIdentifier)
                throw new ParseError({
                    message: 'Only one of group or parentIdentifier can be set',
                    key: 'IMPORT.ERROR_AMBIGUOUS_PARENT_GROUP'
                });

            // The group path extracted from the user-provided connection, to be
            // translated if needed into an absolute path from the root group
            let group = connection.group;

            // Allow the group to start with a leading slash instead instead of
            // explicitly requiring the root connection group
            if (group.startsWith('/'))
                group = ROOT_GROUP_IDENTIFIER + group;

            // Allow groups to begin directly with the path underneath the root
            else if (!group.startsWith(ROOT_GROUP_IDENTIFIER))
                group = ROOT_GROUP_IDENTIFIER + '/' + group;

            // Allow groups to end with a trailing slash
            if (group.endsWith('/'))
                group = group.slice(0, -1);

            // Look up the parent identifier for the specified group path
            const identifier = groupLookups[group];

            // If the group doesn't match anything in the tree
            if (!identifier)
                throw new ParseError({
                    message: 'No group found named: ' + connection.group,
                    key: 'IMPORT.ERROR_INVALID_GROUP',
                    variables: { GROUP: connection.group }
                });

            // Set the parent identifier now that it's known
            return {
                ...connection,
                parentIdentifier: identifier
            };

        });
    }

    /**
     * Convert a provided ImportConnection array into a ParseResult. Any provided
     * transform functions will be run on each entry in `connectionData` before
     * any other processing is done.
     *
     * @param {*[]} connectionData
     *     An arbitrary array of data. This must evaluate to a ImportConnection
     *     object after being run through all functions in `transformFunctions`.
     *
     * @param {Function[]} transformFunctions
     *     An array of transformation functions to run on each entry in
     *     `connection` data.
     *
     * @return {Promise.<Object>}
     *     A promise resolving to ParseResult object representing the result of
     *     parsing all provided connection data.
     */
    function parseConnectionData(connectionData, transformFunctions) {

        // Check that the provided connection data array is not empty
        const checkError = performBasicChecks(connectionData);
        if (checkError) {
            const deferred = $q.defer();
            deferred.reject(checkError);
            return deferred.promise;
        }

        // Get the group transformer to apply to each connection
        return getGroupTransformer().then(groupTransformer =>
                connectionData.reduce((parseResult, data, index) => {

            const { patches, users, groups } = parseResult;

            // Run the array data through each provided transform
            let connectionObject = data;
            _.forEach(transformFunctions, transform => {
                connectionObject = transform(connectionObject);
            });

            // All errors found while parsing this connection
            const connectionErrors = [];
            parseResult.errors.push(connectionErrors);

            // Translate the group on the object to a parentIdentifier
            try {
                connectionObject = groupTransformer(connectionObject);
            }

            // If there was a problem with the group or parentIdentifier
            catch (error) {
                connectionErrors.push(error);
            }

            // The users and user groups that should be granted access
            const connectionUsers = connectionObject.users || [];
            const connectionGroups = connectionObject.groups || [];

            // Add this connection index to the list for each user
            connectionUsers.forEach(identifier => {

                // If there's an existing list, add the index to that
                if (users[identifier])
                    users[identifier].push(index);

                // Otherwise, create a new list with just this index
                else
                    users[identifier] = [index];
            });

            // Add this connection index to the list for each group
            connectionGroups.forEach(identifier => {

                // If there's an existing list, add the index to that
                if (groups[identifier])
                    groups[identifier].push(index);

                // Otherwise, create a new list with just this index
                else
                    groups[identifier] = [index];
            });

            // Translate to a full-fledged Connection
            const connection = new Connection(connectionObject);

            // Finally, add a patch for creating the connection
            patches.push(new DirectoryPatch({
                op: 'add',
                path: '/',
                value: connection
            }));

            // If there are any errors for this connection, fail the whole batch
            if (connectionErrors.length)
                parseResult.hasErrors = true;

            return parseResult;

        }, new ParseResult()));
    }

    /**
     * Convert a provided CSV representation of a connection list into a JSON
     * object to be submitted to the PATCH REST endpoint, as well as a list of
     * objects containing lists of user and user group identifiers to be granted
     * to each connection.
     *
     * @param {String} csvData
     *     The CSV-encoded connection list to process.
     *
     * @return {Promise.<Object>}
     *     A promise resolving to ParseResult object representing the result of
     *     parsing all provided connection data.
     */
    service.parseCSV = function parseCSV(csvData) {

        // Convert to an array of arrays, one per CSV row (including the header)
        // NOTE: skip_empty_lines is required, or a trailing newline will error
        let parsedData;
        try {
            parsedData = parseCSVData(csvData, {skip_empty_lines: true});
        }

        // If the CSV parser throws an error, reject with that error. No
        // translation key will be available here.
        catch(error) {
            console.error(error);
            const deferred = $q.defer();
            deferred.reject(new ParseError({ message: error.message }));
            return deferred.promise;
        }

        // The header row - an array of string header values
        const header = parsedData.length ? parsedData[0] : [];

        // Slice off the header row to get the data rows
        const connectionData = parsedData.slice(1);

        // Generate the CSV transform function, and apply it to every row
        // before applying all the rest of the standard transforms
        return connectionCSVService.getCSVTransformer(header).then(
            csvTransformer =>

                // Apply the CSV transform to every row
                parseConnectionData(connectionData, [csvTransformer]));

    };

    /**
     * Convert a provided YAML representation of a connection list into a JSON
     * object to be submitted to the PATCH REST endpoint, as well as a list of
     * objects containing lists of user and user group identifiers to be granted
     * to each connection.
     *
     * @param {String} yamlData
     *     The YAML-encoded connection list to process.
     *
     * @return {Promise.<Object>}
     *     A promise resolving to ParseResult object representing the result of
     *     parsing all provided connection data.
     */
    service.parseYAML = function parseYAML(yamlData) {

        // Parse from YAML into a javascript array
        let connectionData;
        try {
            connectionData = parseYAMLData(yamlData);
        }

        // If the YAML parser throws an error, reject with that error. No
        // translation key will be available here.
        catch(error) {
            console.error(error);
            const deferred = $q.defer();
            deferred.reject(new ParseError({ message: error.message }));
            return deferred.promise;
        }

        // Produce a ParseResult
        return parseConnectionData(connectionData);
    };

    /**
     * Convert a provided JSON-encoded representation of a connection list into
     * an array of patches to be submitted to the PATCH REST endpoint, as well
     * as a list of objects containing lists of user and user group identifiers
     * to be granted to each connection.
     *
     * @param {String} jsonData
     *     The JSON-encoded connection list to process.
     *
     * @return {Promise.<Object>}
     *     A promise resolving to ParseResult object representing the result of
     *     parsing all provided connection data.
     */
    service.parseJSON = function parseJSON(jsonData) {

        // Parse from JSON into a javascript array
        let connectionData;
        try {
            connectionData = JSON.parse(jsonData);
        }

        // If the JSON parse attempt throws an error, reject with that error.
        // No translation key will be available here.
        catch(error) {
            console.error(error);
            const deferred = $q.defer();
            deferred.reject(new ParseError({ message: error.message }));
            return deferred.promise;
        }

        // Produce a ParseResult
        return parseConnectionData(connectionData);

    };

    return service;

}]);
